require("dotenv").config({path:__dirname+"/.env"});

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
const FINAL_PAUSE=10000;
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

  for(let i=pool.length-1;i>0;i--){
    const j=crypto.randomInt(i+1);
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }

  return pool.slice(0,DRAW_TOTAL);
}

const userSchema=new mongoose.Schema({
  username:{type:String,unique:true,index:true},
  passwordHash:String,
  role:{type:String,default:"customer"},
  balance:{type:Number,default:0},
  referralCode:{type:String,unique:true,sparse:true,index:true},
  referredBy:{type:String,index:true,default:null},
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

const commissionSchema=new mongoose.Schema({
  username:{type:String,index:true},
  sourceUsername:{type:String,index:true},
  depositId:{type:String,index:true},
  level:Number,
  rate:Number,
  amount:Number,
  status:{type:String,default:"LEDGER"},
  createdAt:{type:Date,default:Date.now}
});

commissionSchema.index(
  {depositId:1,username:1,level:1},
  {unique:true}
);

const Commission=mongoose.model("Commission",commissionSchema);

function referralRate(level){
  return 0.10/Math.pow(2,level-1);
}

function makeReferralCode(username){
  return username.toUpperCase()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
}

async function ensureReferralCode(user){
  if(user.referralCode)return user.referralCode;

  let code;
  do{
    code=makeReferralCode(user.username);
  }while(await User.exists({referralCode:code}));

  user.referralCode=code;
  await user.save();
  return code;
}

async function buildReferralChain(username){
  const chain=[];
  let current=await User.findOne({username});

  for(let level=1;level<=50 && current && current.referredBy;level++){

    const ref=String(current.referredBy).trim();

    let parent=await User.findOne({
      referralCode:ref
    });

    if(!parent && /^[a-f0-9]{24}$/i.test(ref)){
      try{
        parent=await User.findById(ref);
      }catch(e){}
    }

    if(!parent)break;

    await ensureReferralCode(parent);

    chain.push({
      level,
      username:parent.username,
      referralCode:parent.referralCode,
      rate:referralRate(level)
    });

    current=parent;
  }

  return chain;
}

async function createReferralLedgerPreview(
  depositId,
  sourcePlayer,
  amount
){
  const chain=await buildReferralChain(sourcePlayer);
  const entries=[];

  for(const parent of chain){
    const commission=Number(
      (amount*parent.rate).toFixed(2)
    );

    if(commission<=0)continue;

    entries.push({
      username:parent.username,
      sourceUsername:sourcePlayer,
      depositId,
      level:parent.level,
      rate:parent.rate,
      amount:commission,
      status:"LEDGER"
    });
  }

  return entries;
}

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
  const existing=await Game.findOne({
    phase:{$in:["BETTING","DRAWING","COMPLETED"]}
  }).sort({game:-1});

  if(existing&&existing.phase!=="COMPLETED"){
    return existing;
  }

  const number=existing?existing.game+1:await nextGameNumber();

  try{
    return await Game.create({
      game:number,
      round:number,
      phase:"BETTING",
      bettingStartedAt:new Date(),
      drawPool:makeDraw(),
      drawnNumbers:[],
      drawIndex:0,
      countdown:BETTING_SECONDS
    });
  }catch(e){
    if(e.code===11000){
      return await Game.findOne({game:number});
    }
    throw e;
  }
}

async function getActiveGame(){
  return await Game.findOne({
    phase:{$in:["BETTING","DRAWING","COMPLETED"]}
  }).sort({game:-1});
}

async function calculateCountdown(g){

 if(g.phase==="BETTING"){

  const started=
   new Date(g.bettingStartedAt).getTime();

  const elapsed=
   Math.floor((Date.now()-started)/1000);

  return Math.max(
   0,
   BETTING_SECONDS-elapsed
  );
 }

 if(g.phase==="DRAWING"){

  return Math.max(
   0,
   DRAW_TOTAL-g.drawIndex
  );
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

    const session=await mongoose.startSession();

    try{

      await session.withTransaction(async()=>{

        const ticket=await Ticket.findOne({
          ticketId:t.ticketId,
          status:"PENDING"
        }).session(session);

        if(!ticket)return;

        ticket.matches=matches;
        ticket.prize=payout;
        ticket.result=result;

        if(payout>0){

          const key="PAYOUT:"+t.ticketId;

          const existing=await Payout.findOne({
            key
          }).session(session);

          if(!existing){

            await Payout.create([{
              key,
              ticketId:t.ticketId,
              username:t.username,
              amount:payout
            }],{session});

            const user=await User.findOneAndUpdate(
              {username:t.username},
              {$inc:{balance:payout}},
              {new:true,session}
            );

            if(!user)
              throw new Error(
                "User not found for payout."
              );
          }
        }

        ticket.status=result;
        ticket.settledAt=new Date();

        await ticket.save({session});
      });

      console.log(
        t.ticketId,
        result,
        "MATCHES",matches,
        "PRIZE",payout
      );

    }catch(e){

      console.error(
        "SETTLEMENT ERROR",
        t.ticketId,
        e.message
      );

      throw e;

    }finally{

      await session.endSession();

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

   const last=await Game.findOne({
    phase:"COMPLETED"
   }).sort({game:-1});

   if(last&&last.completedAt){

    const elapsed=
     Date.now()-new Date(last.completedAt).getTime();

    if(elapsed<FINAL_PAUSE)
     return;
   }

   await createGame();
   return;
  }

  if(g.phase==="BETTING"){

   const remaining=await calculateCountdown(g);

   await Game.updateOne(
    {_id:g._id,phase:"BETTING"},
    {$set:{countdown:remaining}}
   );

   if(remaining<=0){

    await Game.updateOne(
     {_id:g._id,phase:"BETTING"},
     {$set:{
      phase:"DRAWING",
      drawingStartedAt:new Date(),
      countdown:DRAW_TOTAL,
      drawIndex:0,
      drawnNumbers:[]
     }}
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

   /*
    * Draw exactly one number every second.
    * Tickets remain PENDING here.
    */

   if(current.drawIndex<DRAW_TOTAL){

    const index=current.drawIndex;
    const number=current.drawPool[index];

    current.drawnNumbers.push(number);
    current.drawIndex=index+1;
    current.countdown=
     DRAW_TOTAL-current.drawIndex;

    await current.save();

    console.log(
     "DRAW",
     current.drawIndex+"/"+DRAW_TOTAL,
     "NUMBER",
     number
    );
   }

   /*
    * ONLY AFTER NUMBER 20:
    * calculate WIN/LOSE,
    * pay winners,
    * complete the game.
    */

   if(current.drawIndex>=DRAW_TOTAL){

    await settleTickets(current);

    current.phase="COMPLETED";
    current.countdown=0;
    current.completedAt=new Date();

    await current.save();

    console.log(
     "GAME",
     current.game,
     "COMPLETED"
    );

    console.log(
     "⏳ NEXT GAME IN",
     FINAL_PAUSE/1000,
     "SECONDS"
    );
   }

   return;
  }
 }catch(e){

  console.error(
   "GAME LOOP ERROR:",
   e.message
  );

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

    await Game.updateOne(
      {_id:g._id,phase:"BETTING"},
      {$set:{countdown:remaining}}
    );

    if(remaining<=0){

      await Game.updateOne(
        {_id:g._id,phase:"BETTING"},
        {$set:{
          phase:"DRAWING",
          drawingStartedAt:new Date(),
          countdown:DRAW_TOTAL,
          drawIndex:0,
          drawnNumbers:[]
        }}
      );

      console.log(
        "ROUND",g.round,
        "GAME",g.game,
        "DRAWING STARTED"
      );
    }
  }

  if(g.phase==="DRAWING"){

    console.log(
      "▶️ DRAW RESUMED AT",
      g.drawIndex+"/"+DRAW_TOTAL
    );

    if(g.drawIndex>=DRAW_TOTAL){

      await settleTickets(g);

      g.phase="COMPLETED";
      g.countdown=0;
      g.completedAt=new Date();

      await g.save();

      console.log(
        "GAME",
        g.game,
        "COMPLETED AFTER RECOVERY"
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
    const referralCode=String(q.body.referralCode||"").trim();

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

    let referredBy=null;

    if(referralCode){
      const parent=await User.findOne({
        referralCode:referralCode
      });

      if(!parent)
        return r.status(400).json({
          success:false,
          message:"Invalid referral code."
        });

      if(parent.username===username)
        return r.status(400).json({
          success:false,
          message:"You cannot refer yourself."
        });

      referredBy=parent.referralCode;
    }

    const exists=await User.findOne({username});

    if(exists)
      return r.status(409).json({
        success:false,
        message:"Username already exists."
      });

    const passwordHash=await bcrypt.hash(password,12);

    const user=await User.create({
      username,
      passwordHash,
      role:"customer",
      balance:0,
      referredBy
    });

    await ensureReferralCode(user);

    r.json({
      success:true,
      message:"Registration successful.",
      referralCode:user.referralCode
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

app.get("/api/referrals",async(q,r)=>{
  try{
    const user=await getUser(q);

    if(!user)
      return r.status(401).json({
        message:"Login required."
      });

    await ensureReferralCode(user);

    const direct=await User.find({
      referredBy:user.referralCode
    })
    .select("username referralCode createdAt")
    .sort({createdAt:-1});

    const chain=await buildReferralChain(
      user.username
    );

    const ledger=await Commission.find({
      username:user.username
    })
    .sort({createdAt:-1})
    .limit(200);

    const total=ledger.reduce(
      (sum,x)=>sum+x.amount,
      0
    );

    r.json({
      referralCode:user.referralCode,
      directReferrals:direct,
      chain,
      totalLedger:Number(total.toFixed(2)),
      ledger
    });

  }catch(e){
    console.error(e);

    r.status(500).json({
      message:e.message
    });
  }
});

app.get("/api/referrals/chain",async(q,r)=>{
  try{
    const user=await getUser(q);

    if(!user)
      return r.status(401).json({
        message:"Login required."
      });

    r.json(
      await buildReferralChain(user.username)
    );

  }catch(e){
    r.status(500).json({
      message:e.message
    });
  }
});

app.get("/api/admin/referrals",async(q,r)=>{
  try{
    await admin(q);

    r.json(
      await Commission.find({})
      .sort({createdAt:-1})
      .limit(1000)
    );

  }catch(e){
    r.status(403).json({
      message:e.message
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

          console.log(
            "REFERRAL CHECK:",
            t.username,
            "DEPOSIT",
            t.amount
          );

          const entries=await createReferralLedgerPreview(
            t.transactionId||t.id,
            t.username,
            t.amount
          );

          console.log(
            "REFERRAL ENTRIES:",
            JSON.stringify(entries)
          );

          for(const entry of entries){

            const existing=await Commission.findOne({
              depositId:entry.depositId,
              username:entry.username,
              level:entry.level
            }).session(session);

            if(existing){
              console.log(
                "REFERRAL ALREADY PAID",
                entry.depositId,
                entry.username,
                entry.amount
              );
              continue;
            }

            const referrer=await User.findOneAndUpdate(
              {username:entry.username},
              {$inc:{balance:entry.amount}},
              {new:true,session}
            );

            if(!referrer)
              throw new Error(
                "Referral user not found: "+entry.username
              );

            await Commission.create([entry],{session});

            console.log(
              "REFERRAL COMMISSION",
              entry.username,
              "+",
              entry.amount,
              "ETB",
              "LEVEL",
              entry.level
            );
          }
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
  try{
    const active=await Game.findOne({
      phase:{$in:["BETTING","DRAWING"]}
    });

    if(active){
      return r.status(400).json({
        success:false,
        message:"A game is already active."
      });
    }

    const g=await createGame();

    r.json({
      success:true,
      message:"New game started. Balance and history preserved.",
      game:g.game,
      round:g.round
    });
  }catch(e){
    console.error("RESET ERROR:",e.message);
    r.status(500).json({
      success:false,
      message:"Reset failed."
    });
  }
});

async function createAdmin(){
  const username=process.env.ADMIN_USERNAME||"admin";
  const password=process.env.ADMIN_PASSWORD;

  if(!password){
    console.log("⚠️ ADMIN_PASSWORD is not set.");
    return;
  }

  const exists=await User.findOne({username});

  if(exists){
    if(exists.role!=="admin"){
      exists.role="admin";
      await exists.save();
      console.log("✅ Existing user promoted to admin:",username);
    }else{
      console.log("✅ Admin already exists:",username);
    }
    return;
  }

  const passwordHash=await bcrypt.hash(password,12);

  await User.create({
    username,
    passwordHash,
    role:"admin",
    balance:0
  });

  console.log("✅ Admin account created:",username);
}

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

  await createAdmin();

  await startup();

  setInterval(gameLoop,DRAW_INTERVAL);

  app.listen(PORT,"0.0.0.0",()=>{
    console.log("🚀 Server running on port",PORT);
  });
}

main().catch(e=>{
  console.error("❌ STARTUP ERROR:",e.message);
  process.exit(1);
});
