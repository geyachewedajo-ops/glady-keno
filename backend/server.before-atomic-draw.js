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

let bettingTimer=null;
let drawTimer=null;

async function startDrawing(g){

 try{

  const current=await Game.findById(g._id);

  if(!current||current.phase!=="BETTING")
   return;

  current.phase="DRAWING";
  current.drawingStartedAt=new Date();
  current.countdown=DRAW_TOTAL;
  current.drawIndex=0;
  current.drawnNumbers=[];

  await current.save();

  console.log(
   "ROUND",current.round,
   "GAME",current.game,
   "DRAWING STARTED"
  );

  scheduleDraw(current._id);

 }catch(e){

  console.error(
   "START DRAW ERROR:",
   e.message
  );
 }
}

function scheduleBetting(g){

 if(bettingTimer)
  clearTimeout(bettingTimer);

 const started=
  new Date(g.bettingStartedAt).getTime();

 const delay=Math.max(
  0,
  BETTING_SECONDS*1000-
  (Date.now()-started)
 );

 console.log(
  "BETTING TIMER:",
  Math.ceil(delay/1000),
  "seconds"
 );

 bettingTimer=setTimeout(
  ()=>startDrawing(g),
  delay
 );
}

function scheduleDraw(id){

 if(drawTimer)
  clearTimeout(drawTimer);

 drawTimer=setTimeout(
  ()=>drawOneNumber(id),
  1000
 );
}

async function drawOneNumber(id){

 try{

  const g=await Game.findById(id);

  if(!g||g.phase!=="DRAWING")
   return;

  if(g.drawIndex>=DRAW_TOTAL){
   await completeGame(g);
   return;
  }

  const index=g.drawIndex;
  const number=g.drawPool[index];

  g.drawnNumbers.push(number);
  g.drawIndex=index+1;
  g.countdown=
   DRAW_TOTAL-g.drawIndex;

  await g.save();

  console.log(
   "DRAW",
   g.drawIndex+"/"+DRAW_TOTAL,
   "NUMBER",
   number
  );

  if(g.drawIndex>=DRAW_TOTAL){

   await completeGame(g);
   return;
  }

  scheduleDraw(g._id);

 }catch(e){

  console.error(
   "DRAW ERROR:",
   e.message
  );

  scheduleDraw(id);
 }
}

async function completeGame(g){

 await settleTickets(g);

 g.phase="COMPLETED";
 g.countdown=0;
 g.completedAt=new Date();

 await g.save();

 console.log(
  "GAME",g.game,
  "COMPLETED"
 );

 const next=await createGame();

 scheduleBetting(next);
}

async function startup(){

 const g=await Game.findOne({
  phase:{$in:["BETTING","DRAWING"]}
 }).sort({game:-1});

 if(!g){

  const newGame=await createGame();

  console.log(
   "🆕 NEW GAME",
   newGame.game
  );

  scheduleBetting(newGame);
  return;
 }

 console.log(
  "♻️ RECOVERED",
  "ROUND",g.round,
  "GAME",g.game,
  "PHASE",g.phase,
  "DRAWN",
  g.drawIndex+"/"+DRAW_TOTAL
 );

 if(g.phase==="BETTING"){

  const remaining=
   await calculateCountdown(g);

  if(remaining<=0){

   await startDrawing(g);

  }else{

   scheduleBetting(g);
  }

 }

 if(g.phase==="DRAWING"){

  console.log(
   "▶️ RESUMING DRAW",
   g.drawIndex+"/"+DRAW_TOTAL
  );

  scheduleDraw(g._id);
 }
}

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


  app.listen(PORT,"0.0.0.0",()=>{
    console.log("🚀 Server running on port",PORT);
  });
}

main().catch(e=>{
  console.error("❌ STARTUP ERROR:",e.message);
  process.exit(1);
});
