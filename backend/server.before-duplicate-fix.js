require("dotenv").config();

const express=require("express");
const cors=require("cors");
const crypto=require("crypto");
const mongoose=require("mongoose");
const bcrypt=require("bcryptjs");

const app=express();
const PORT=5000;

app.use(cors());
app.use(express.json());

const BETTING_SECONDS=60;
const DRAW_TOTAL=20;
const DRAW_INTERVAL=1000;
const COMPLETE_WAIT=4000;
const MAX_TICKETS=10000;

const prizeTable={
  1:{1:2},
  2:{1:1,2:8},
  3:{2:2,3:15},
  4:{2:1,3:5,4:30},
  5:{2:1,3:3,4:15,5:50},
  6:{3:2,4:8,5:30,6:100},
  7:{3:1,4:5,5:20,6:75,7:250},
  8:{4:2,5:10,6:40,7:150,8:500},
  9:{4:2,5:10,6:50,7:200,8:750,9:2500},
  10:{5:5,6:20,7:100,8:500,9:2500,10:10000}
};

function prize(selected,matches,stake){
  return stake*(prizeTable[selected]?.[matches]||0);
}

function makeDraw(){
  const pool=Array.from({length:80},(_,i)=>i+1);
  const result=[];

  while(result.length<DRAW_TOTAL){
    const i=Math.floor(Math.random()*pool.length);
    result.push(pool[i]);
    pool.splice(i,1);
  }

  return result;
}

const userSchema=new mongoose.Schema({
  username:{type:String,unique:true,index:true},
  passwordHash:String,
  role:{type:String,default:"customer"},
  balance:{type:Number,default:0},
  createdAt:{type:Date,default:Date.now}
});

const gameSchema=new mongoose.Schema({
  game:{type:Number,unique:true,index:true},
  round:{type:Number,index:true},
  phase:String,
  bettingStartedAt:Date,
  drawingStartedAt:Date,
  completedAt:Date,
  drawPool:[Number],
  drawnNumbers:[Number],
  drawIndex:{type:Number,default:0},
  countdown:{type:Number,default:BETTING_SECONDS}
});

const ticketSchema=new mongoose.Schema({
  ticketId:{type:String,unique:true,index:true},
  username:{type:String,index:true},
  round:Number,
  game:Number,
  numbers:[Number],
  stake:Number,
  matches:{type:Number,default:0},
  prize:{type:Number,default:0},
  result:{type:String,default:"PENDING"},
  status:{type:String,default:"PENDING"},
  createdAt:{type:Date,default:Date.now},
  settledAt:Date
});

const transactionSchema=new mongoose.Schema({
  id:{type:String,unique:true,index:true},
  type:String,
  transactionId:{type:String,index:true,sparse:true},
  name:String,
  account:String,
  username:{type:String,index:true},
  amount:Number,
  status:{type:String,default:"PENDING"},
  createdAt:{type:Date,default:Date.now},
  processedAt:Date
});

const sessionSchema=new mongoose.Schema({
  token:{type:String,unique:true,index:true},
  username:String,
  role:String,
  expiresAt:Date,
  createdAt:{type:Date,default:Date.now}
});

const payoutSchema=new mongoose.Schema({
  key:{type:String,unique:true,index:true},
  ticketId:String,
  username:String,
  amount:Number,
  createdAt:{type:Date,default:Date.now}
});

const User=mongoose.model("User",userSchema);
const Game=mongoose.model("Game",gameSchema);
const Ticket=mongoose.model("Ticket",ticketSchema);
const Transaction=mongoose.model("Transaction",transactionSchema);
const Session=mongoose.model("Session",sessionSchema);
const Payout=mongoose.model("Payout",payoutSchema);

async function getUser(req){
  const auth=req.headers.authorization||"";

  if(!auth.startsWith("Bearer "))
    return null;

  const token=auth.slice(7);

  const s=await Session.findOne({
    token,
    expiresAt:{$gt:new Date()}
  });

  if(!s)return null;

  return await User.findOne({username:s.username});
}

async function login(req,res,next){
  try{
    const u=await getUser(req);

    if(!u)
      return res.status(401).json({
        success:false,
        message:"Please login."
      });

    req.user=u;
    next();
  }catch(e){
    res.status(500).json({
      success:false,
      message:"Authentication error."
    });
  }
}

async function admin(req,res,next){
  try{
    const u=await getUser(req);

    if(!u||u.role!=="admin")
      return res.status(403).json({
        success:false,
        message:"Admin access required."
      });

    req.user=u;
    next();
  }catch(e){
    res.status(500).json({
      success:false,
      message:"Authentication error."
    });
  }
}

async function nextGameNumber(){
  const last=await Game.findOne().sort({game:-1});
  return last?last.game+1:1;
}

async function createGame(){
  const number=await nextGameNumber();

  const g=await Game.create({
    game:number,
    round:number,
    phase:"BETTING",
    bettingStartedAt:new Date(),
    drawPool:makeDraw(),
    drawnNumbers:[],
    drawIndex:0,
    countdown:BETTING_SECONDS
  });

  console.log("ROUND",g.round,"GAME",g.game,"BETTING STARTED");

  return g;
}

async function getActiveGame(){
  return await Game.findOne({
    phase:{$in:["BETTING","DRAWING","COMPLETED"]}
  }).sort({game:-1});
}

async function calculateCountdown(g){
  if(g.phase==="BETTING"){
    const elapsed=Math.floor(
      (Date.now()-new Date(g.bettingStartedAt).getTime())/1000
    );

    return Math.max(0,BETTING_SECONDS-elapsed);
  }

  if(g.phase==="DRAWING"){
    return Math.max(0,DRAW_TOTAL-g.drawIndex);
  }

  return 0;
}

async function settleTickets(g){
  const tickets=await Ticket.find({
    game:g.game,
    status:"PENDING"
  });

  for(const t of tickets){
    const matches=t.numbers.filter(
      n=>g.drawnNumbers.includes(n)
    ).length;

    const payout=prize(
      t.numbers.length,
      matches,
      t.stake
    );

    const result=payout>0?"WIN":"LOSE";

    const updated=await Ticket.findOneAndUpdate(
      {
        ticketId:t.ticketId,
        status:"PENDING"
      },
      {
        $set:{
          matches,
          prize:payout,
          result,
          status:result,
          settledAt:new Date()
        }
      },
      {new:true}
    );

    if(!updated)continue;

    if(payout>0){
      const key="PAYOUT:"+t.ticketId;

      try{
        await Payout.create({
          key,
          ticketId:t.ticketId,
          username:t.username,
          amount:payout
        });

        await User.updateOne(
          {username:t.username},
          {$inc:{balance:payout}}
        );

        console.log(
          t.ticketId,
          "WIN",
          "MATCHES",matches,
          "PRIZE",payout
        );

      }catch(e){
        if(e.code!==11000)throw e;
      }
    }else{
      console.log(
        t.ticketId,
        "LOSE",
        "MATCHES",matches
      );
    }
  }
}

let processing=false;

async function gameLoop(){
  if(processing)return;

  processing=true;

  try{
    let g=await Game.findOne({
      phase:{$in:["BETTING","DRAWING"]}
    }).sort({game:-1});

    if(!g){
      g=await createGame();
      return;
    }

    if(g.phase==="BETTING"){
      const remaining=await calculateCountdown(g);

      await Game.updateOne(
        {_id:g._id},
        {$set:{countdown:remaining}}
      );

      if(remaining<=0){
        await Game.updateOne(
          {_id:g._id,phase:"BETTING"},
          {
            $set:{
              phase:"DRAWING",
              drawingStartedAt:new Date(),
              countdown:DRAW_TOTAL,
              drawIndex:0,
              drawnNumbers:[]
            }
          }
        );

        console.log(
          "ROUND",g.round,
          "GAME",g.game,
          "DRAWING STARTED"
        );
      }

      return;
    }

    if(g.phase==="DRAWING"){
      const current=await Game.findById(g._id);

      if(!current||current.phase!=="DRAWING")
        return;

      if(current.drawIndex<DRAW_TOTAL){
        const number=current.drawPool[current.drawIndex];

        current.drawnNumbers.push(number);
        current.drawIndex++;

        current.countdown=
          DRAW_TOTAL-current.drawIndex;

        await current.save();

        console.log(
          "ROUND",current.round,
          "GAME",current.game,
          "DRAW",
          current.drawIndex+"/"+DRAW_TOTAL,
          "NUMBER",
          number
        );

        if(current.drawIndex>=DRAW_TOTAL){
          await settleTickets(current);

          current.phase="COMPLETED";
          current.countdown=0;
          current.completedAt=new Date();

          await current.save();

          console.log(
            "ROUND",current.round,
            "GAME",current.game,
            "COMPLETED"
          );
        }
      }
    }

  }catch(e){
    console.error("GAME LOOP ERROR:",e.message);
  }finally{
    processing=false;
  }
}

async function startup(){
  const g=await Game.findOne({
    phase:{$in:["BETTING","DRAWING"]}
  }).sort({game:-1});

  if(!g){
    await createGame();
    return;
  }

  console.log(
    "♻️ RECOVERED",
    "ROUND",g.round,
    "GAME",g.game,
    "PHASE",g.phase,
    "DRAWN",g.drawIndex+"/"+DRAW_TOTAL
  );

  if(g.phase==="BETTING"){
    const remaining=await calculateCountdown(g);

    if(remaining<=0){
      await Game.updateOne(
        {_id:g._id},
        {
          $set:{
            phase:"DRAWING",
            drawingStartedAt:new Date(),
            countdown:DRAW_TOTAL
          }
        }
      );
    }
  }
}

app.get("/",(q,r)=>{
  r.json({
    success:true,
    message:"🎱 Glady Keno API is running"
  });
});

app.get("/api/health",(q,r)=>{
  r.json({
    success:true,
    message:"Glady Keno API is running"
  });
});

app.post("/api/register",async(q,r)=>{
  try{
    const username=String(q.body.username||"").trim();
    const password=String(q.body.password||"");
    const confirm=String(q.body.confirmPassword||"");

    if(!/^[a-zA-Z0-9_]{3,20}$/.test(username))
      return r.status(400).json({
        success:false,
        message:"Username must be 3-20 characters."
      });

    if(password.length<4)
      return r.status(400).json({
        success:false,
        message:"Password must be at least 4 characters."
      });

    if(password!==confirm)
      return r.status(400).json({
        success:false,
        message:"Passwords do not match."
      });

    const exists=await User.findOne({username});

    if(exists)
      return r.status(409).json({
        success:false,
        message:"Username already exists."
      });

    const passwordHash=await bcrypt.hash(password,12);

    await User.create({
      username,
      passwordHash,
      role:"customer",
      balance:0
    });

    r.json({
      success:true,
      message:"Registration successful."
    });

  }catch(e){
    console.error(e);

    r.status(500).json({
      success:false,
      message:"Registration failed."
    });
  }
});

app.post("/api/login",async(q,r)=>{
  try{
    const username=String(q.body.username||"").trim();
    const password=String(q.body.password||"");

    const u=await User.findOne({username});

    if(!u)
      return r.status(401).json({
        success:false,
        message:"Invalid username or password."
      });

    const valid=await bcrypt.compare(
      password,
      u.passwordHash
    );

    if(!valid)
      return r.status(401).json({
        success:false,
        message:"Invalid username or password."
      });

    const token=crypto.randomBytes(32).toString("hex");

    await Session.create({
      token,
      username:u.username,
      role:u.role,
      expiresAt:new Date(Date.now()+7*24*60*60*1000)
    });

    r.json({
      success:true,
      token,
      username:u.username,
      role:u.role,
      balance:u.balance||0
    });

  }catch(e){
    console.error(e);

    r.status(500).json({
      success:false,
      message:"Login failed."
    });
  }
});

app.post("/api/logout",login,async(q,r)=>{
  const auth=q.headers.authorization||"";
  const token=auth.slice(7);

  await Session.deleteOne({token});

  r.json({success:true});
});

app.get("/api/games",login,async(q,r)=>{
  const balance=q.user.balance||0;

  const list=await Game.find()
    .sort({game:-1})
    .limit(100);

  r.json({
    success:true,
    round:list.length?list[0].round:1,
    balance,
    games:list.map(g=>({
      game:g.game,
      round:g.round,
      phase:g.phase,
      countdown:g.countdown,
      drawnNumbers:g.drawnNumbers,
      drawIndex:g.drawIndex,
      drawTotal:DRAW_TOTAL,
      ticketCount:0
    }))
  });
});

app.post("/api/games/:id/play",login,async(q,r)=>{
  const session=await mongoose.startSession();

  try{
    if(q.user.role!=="customer")
      return r.status(403).json({
        success:false,
        message:"Customer account required."
      });

    const tickets=q.body.tickets;
    const stake=Number(q.body.stake);

    if(!Array.isArray(tickets)||tickets.length<1)
      return r.status(400).json({
        success:false,
        message:"Add at least one ticket."
      });

    if(tickets.length>MAX_TICKETS)
      return r.status(400).json({
        success:false,
        message:"Maximum 10,000 tickets."
      });

    if(!Number.isFinite(stake)||stake<=0)
      return r.status(400).json({
        success:false,
        message:"Invalid stake."
      });

    for(const numbers of tickets){
      if(
        !Array.isArray(numbers)||
        numbers.length<1||
        numbers.length>10
      )
        return r.status(400).json({
          success:false,
          message:"Each ticket must have 1 to 10 numbers."
        });

      if(
        new Set(numbers).size!==numbers.length||
        numbers.some(
          n=>!Number.isInteger(n)||n<1||n>80
        )
      )
        return r.status(400).json({
          success:false,
          message:"Invalid numbers in ticket."
        });
    }

    const total=stake*tickets.length;

    let game;
    let newBalance;

    await session.withTransaction(async()=>{
      game=await Game.findOne({
        game:Number(q.params.id),
        phase:"BETTING"
      }).session(session);

      if(!game)
        throw new Error("Betting is closed. Wait for the next game.");

      const user=await User.findOneAndUpdate(
        {
          username:q.user.username,
          balance:{$gte:total}
        },
        {$inc:{balance:-total}},
        {new:true,session}
      );

      if(!user)
        throw new Error("Insufficient balance.");

      newBalance=user.balance;

      for(const numbers of tickets){
        await Ticket.create([{
          ticketId:
            "T"+crypto.randomBytes(8).toString("hex").toUpperCase(),
          username:q.user.username,
          round:game.round,
          game:game.game,
          numbers:[...numbers],
          stake,
          matches:0,
          prize:0,
          result:"PENDING",
          status:"PENDING"
        }],{session});
      }
    });

    r.json({
      success:true,
      message:
        `${tickets.length} ticket${tickets.length===1?"":"s"} created.`,
      balance:newBalance,
      created:tickets.length,
      game:game.game
    });

  }catch(e){
    r.status(400).json({
      success:false,
      message:e.message
    });
  }finally{
    await session.endSession();
  }
});

app.post("/api/deposit",login,async(q,r)=>{
  try{
    const name=String(q.body.name||"").trim();
    const transactionId=String(q.body.transactionId||"").trim();
    const amount=Number(q.body.amount);

    if(
      !name||
      !transactionId||
      !Number.isFinite(amount)||
      amount<=0
    )
      return r.status(400).json({
        success:false,
        message:"Enter transaction ID, name and amount."
      });

    const exists=await Transaction.findOne({
      type:"DEPOSIT",
      transactionId
    });

    if(exists)
      return r.status(409).json({
        success:false,
        message:"Transaction ID already exists."
      });

    const t=await Transaction.create({
      id:"TX"+crypto.randomBytes(8).toString("hex").toUpperCase(),
      type:"DEPOSIT",
      transactionId,
      name,
      username:q.user.username,
      amount,
      status:"PENDING"
    });

    r.json({
      success:true,
      message:"Deposit submitted for approval.",
      transaction:t
    });

  }catch(e){
    r.status(500).json({
      success:false,
      message:"Deposit failed."
    });
  }
});

app.post("/api/withdraw",login,async(q,r)=>{
  const session=await mongoose.startSession();

  try{
    const name=String(q.body.name||"").trim();
    const account=String(q.body.account||"").trim();
    const amount=Number(q.body.amount);

    if(
      !name||
      !account||
      !Number.isFinite(amount)||
      amount<=0
    )
      return r.status(400).json({
        success:false,
        message:"Enter name, account number and amount."
      });

    let balance;

    await session.withTransaction(async()=>{
      const u=await User.findOneAndUpdate(
        {
          username:q.user.username,
          balance:{$gte:amount}
        },
        {$inc:{balance:-amount}},
        {new:true,session}
      );

      if(!u)
        throw new Error("Insufficient balance.");

      balance=u.balance;

      await Transaction.create([{
        id:"TX"+crypto.randomBytes(8).toString("hex").toUpperCase(),
        type:"WITHDRAW",
        name,
        account,
        username:q.user.username,
        amount,
        status:"PENDING"
      }],{session});
    });

    r.json({
      success:true,
      message:"Withdrawal submitted.",
      balance
    });

  }catch(e){
    r.status(400).json({
      success:false,
      message:e.message
    });
  }finally{
    await session.endSession();
  }
});

app.get("/api/transactions",login,async(q,r)=>{
  const list=await Transaction.find({
    username:q.user.username
  }).sort({createdAt:-1}).limit(100);

  r.json({
    success:true,
    transactions:list
  });
});

app.get("/api/admin/transactions",admin,async(q,r)=>{
  const list=await Transaction.find()
    .sort({createdAt:-1})
    .limit(500);

  r.json({
    success:true,
    transactions:list
  });
});

app.post("/api/admin/transactions/:id/:action",admin,async(q,r)=>{
  const session=await mongoose.startSession();

  try{
    const action=q.params.action;

    if(!["approve","reject"].includes(action))
      return r.status(400).json({
        success:false,
        message:"Invalid action."
      });

    await session.withTransaction(async()=>{
      const t=await Transaction.findOne({
        id:q.params.id,
        status:"PENDING"
      }).session(session);

      if(!t)
        throw new Error("Transaction not found or already processed.");

      const u=await User.findOne({
        username:t.username
      }).session(session);

      if(!u)
        throw new Error("User not found.");

      if(action==="approve"){
        if(t.type==="DEPOSIT"){
          u.balance+=t.amount;
          await u.save({session});
        }

        t.status="APPROVED";
      }

      if(action==="reject"){
        if(t.type==="WITHDRAW"){
          u.balance+=t.amount;
          await u.save({session});
        }

        t.status="REJECTED";
      }

      t.processedAt=new Date();
      await t.save({session});
    });

    r.json({
      success:true,
      message:`Transaction ${action}d.`
    });

  }catch(e){
    r.status(400).json({
      success:false,
      message:e.message
    });
  }finally{
    await session.endSession();
  }
});

app.get("/api/tickets/history",login,async(q,r)=>{
  const list=await Ticket.find({
    username:q.user.username
  }).sort({createdAt:-1}).limit(500);

  r.json({
    success:true,
    tickets:list
  });
});

app.get("/api/admin/tickets/history",admin,async(q,r)=>{
  const list=await Ticket.find()
    .sort({createdAt:-1})
    .limit(500);

  r.json({
    success:true,
    tickets:list
  });
});

app.get("/api/admin/status",admin,async(q,r)=>{
  const games=await Game.find()
    .sort({game:-1})
    .limit(100);

  const totalTransactions=await Transaction.countDocuments();

  const counts=await Ticket.aggregate([
    {$group:{_id:"$game",count:{$sum:1}}}
  ]);

  const map=new Map(
    counts.map(x=>[x._id,x.count])
  );

  r.json({
    success:true,
    round:games.length?games[0].round:1,
    games:games.map(g=>({
      game:g.game,
      round:g.round,
      phase:g.phase,
      countdown:g.countdown,
      drawIndex:g.drawIndex,
      ticketCount:map.get(g.game)||0,
      drawnNumbers:g.drawnNumbers
    })),
    totalTransactions
  });
});

app.post("/api/game/reset",admin,async(q,r)=>{
  /*
   Persistent financial records are NOT deleted.
   Only completed game records may be removed during testing.
  */

  const active=await Game.findOne({
    phase:{$in:["BETTING","DRAWING"]}
  });

  if(active)
    return r.status(400).json({
      success:false,
      message:"Cannot reset while a game is active."
    });

  await Game.deleteMany({});

  await createGame();

  r.json({
    success:true,
    message:"Game rounds reset. Financial records preserved."
  });
});

async function main(){
  if(!process.env.MONGODB_URI){
    throw new Error("MONGODB_URI is missing.");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  console.log("================================");
  console.log("🎱 GLADY KENO BACKEND");
  console.log("✅ MONGODB CONNECTED");
  console.log("60 SECOND BETTING");
  console.log("1 SECOND BETWEEN NUMBERS");
  console.log("20 NUMBERS DRAWN");
  console.log("PERSISTENT USERS");
  console.log("PERSISTENT BALANCES");
  console.log("PERSISTENT TICKETS");
  console.log("PERSISTENT ROUNDS");
  console.log("PERSISTENT DRAW SEQUENCE");
  console.log("PERSISTENT TRANSACTIONS");
  console.log("================================");

  await startup();

  setInterval(gameLoop,1000);

  app.listen(PORT,"0.0.0.0",()=>{
    console.log("🚀 Server running on port",PORT);
  });
}

main().catch(e=>{
  console.error("❌ STARTUP ERROR:",e.message);
  process.exit(1);
});
