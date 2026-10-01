const express=require("express"),cors=require("cors"),crypto=require("crypto");
const app=express(),PORT=5000;

app.use(cors());
app.use(express.json());

const USERS={
 player:{password:"1234",role:"customer",balance:0},
 admin:{password:"molden123",role:"admin"}
};

const sessions=new Map(),transactions=[];
const MAX_GAMES=100,MAX_TICKETS=10000;
const BETTING_SECONDS=60,DRAW_TOTAL=20,DRAW_INTERVAL=1000;

let ticketCounter=1,transactionCounter=1;
let games=[],gameNumber=0,round=1;

function token(){
 return crypto.randomBytes(24).toString("hex")
}

function getUser(req){
 const a=req.headers.authorization||"";
 return a.startsWith("Bearer ")
  ?sessions.get(a.slice(7))||null
  :null
}

function login(req,res,next){
 const u=getUser(req);

 if(!u)
  return res.status(401).json({
   success:false,
   message:"Please login."
  });

 req.user=u;
 next()
}

function admin(req,res,next){
 const u=getUser(req);

 if(!u||u.role!=="admin")
  return res.status(403).json({
   success:false,
   message:"Admin access required."
  });

 req.user=u;
 next()
}

function makeDraw(){
 const p=Array.from({length:80},(_,i)=>i+1);
 const r=[];

 while(r.length<DRAW_TOTAL){
  const i=Math.floor(Math.random()*p.length);
  r.push(p[i]);
  p.splice(i,1);
 }

 return r
}

function prize(selected,matches,stake){
 const table={
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

 return stake*(table[selected]?.[matches]||0)
}

function createGame(){
 if(games.length>=MAX_GAMES)return null;

 gameNumber++;
 round=gameNumber;

 const g={
  game:gameNumber,
  round,
  phase:"BETTING",
  countdown:BETTING_SECONDS,
  drawnNumbers:[],
  drawPool:makeDraw(),
  drawIndex:0,
  tickets:[]
 };

 games.push(g);

 console.log(
  "ROUND",g.round,
  "GAME",g.game,
  "BETTING STARTED - 60 SECONDS"
 );

 return g
}

createGame();

function finishGame(g){
 if(g.phase==="COMPLETED")return;

 g.phase="COMPLETED";
 g.countdown=0;

 console.log(
  "ROUND",g.round,
  "GAME",g.game,
  "COMPLETED"
 );

 g.tickets.forEach(t=>{
  console.log(
   t.ticketId,
   t.result,
   "MATCHES",t.matches,
   "PRIZE",t.prize
  );
 });

 setTimeout(()=>{
  if(
   g===games[games.length-1]&&
   games.length<MAX_GAMES
  ){
   createGame();
  }
 },4000);
}

function drawNextNumber(g){
 if(g.phase!=="DRAWING")return;

 if(g.drawIndex>=DRAW_TOTAL){
  finishGame(g);
  return;
 }

 const n=g.drawPool[g.drawIndex];

 g.drawnNumbers.push(n);
 g.drawIndex++;

 console.log(
  "ROUND",g.round,
  "GAME",g.game,
  "DRAW",
  g.drawIndex+"/"+DRAW_TOTAL,
  "NUMBER",
  n
 );

 if(g.drawIndex>=DRAW_TOTAL){

  /*
   FINAL NUMBER DRAWN.
   CALCULATE EVERY TICKET NOW.
  */

  g.tickets.forEach(t=>{

   t.matches=t.numbers.filter(
    n=>g.drawnNumbers.includes(n)
   ).length;

   t.prize=prize(
    t.numbers.length,
    t.matches,
    t.stake
   );

   if(t.prize>0){
    t.result="WIN";
    t.status="WIN";

    if(USERS[t.username]){
     USERS[t.username].balance+=t.prize;
    }

   }else{
    t.result="LOSE";
    t.status="LOSE";
   }

   console.log(
    t.ticketId,
    "=>",
    t.result,
    "MATCHES:",
    t.matches,
    "PRIZE:",
    t.prize
   );
  });

  g.countdown=0;

  /*
   Keep completed game visible for 4 seconds,
   then create the next game.
  */

  g.phase="COMPLETED";

  console.log(
   "ROUND",g.round,
   "GAME",g.game,
   "COMPLETED"
  );

  setTimeout(()=>{
   if(
    g===games[games.length-1] &&
    games.length<MAX_GAMES
   ){
    createGame();
   }
  },4000);

 }else{

  g.countdown=DRAW_TOTAL-g.drawIndex;

  setTimeout(()=>{
   drawNextNumber(g);
  },DRAW_INTERVAL);
 }
}

setInterval(()=>{
 games.forEach(g=>{

  if(g.phase==="BETTING"){

   g.countdown--;

   if(g.countdown<=0){

    g.phase="DRAWING";
    g.drawIndex=0;
    g.drawnNumbers=[];

    console.log(
     "ROUND",g.round,
     "GAME",g.game,
     "DRAWING STARTED"
    );

    setTimeout(()=>{
     drawNextNumber(g);
    },1000);
   }
  }

 });
},1000);

app.get("/",(q,r)=>{
 r.json({
  success:true,
  message:"🎱 Glady Keno API is running"
 })
});

app.get("/api/health",(q,r)=>{
 r.json({
  success:true,
  message:"Glady Keno API is running"
 })
});

app.post("/api/register",(q,r)=>{
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

 if(USERS[username])
  return r.status(409).json({
   success:false,
   message:"Username already exists."
  });

 USERS[username]={
  password,
  role:"customer",
  balance:0
 };

 r.json({
  success:true,
  message:"Registration successful."
 });
});

app.post("/api/login",(q,r)=>{
 const username=String(q.body.username||"").trim();
 const password=String(q.body.password||"");
 const u=USERS[username];

 if(!u||u.password!==password)
  return r.status(401).json({
   success:false,
   message:"Invalid username or password."
  });

 const t=token();

 sessions.set(t,{
  username,
  role:u.role
 });

 r.json({
  success:true,
  token:t,
  username,
  role:u.role,
  balance:u.balance||0
 });
});

app.post("/api/logout",login,(q,r)=>{
 sessions.delete(
  q.headers.authorization.slice(7)
 );

 r.json({
  success:true
 })
});

app.get("/api/games",login,(q,r)=>{
 const u=USERS[q.user.username];

 r.json({
  success:true,
  round,
  balance:u.balance||0,

  games:games.map(g=>({
   game:g.game,
   round:g.round,
   phase:g.phase,
   countdown:g.countdown,
   drawnNumbers:g.drawnNumbers,
   drawIndex:g.drawIndex,
   drawTotal:DRAW_TOTAL,
   ticketCount:g.tickets.length
  }))
 });
});

/*
 ADD MULTIPLE DIFFERENT TICKETS
 IN ONE GAME
*/
app.post("/api/games/:id/play",login,(q,r)=>{
 const u=USERS[q.user.username];

 if(q.user.role!=="customer")
  return r.status(403).json({
   success:false,
   message:"Customer account required."
  });

 const g=games.find(
  x=>x.game===Number(q.params.id)
 );

 if(!g)
  return r.status(404).json({
   success:false,
   message:"Game not found."
  });

 if(g.phase!=="BETTING")
  return r.status(400).json({
   success:false,
   message:"Betting is closed. Wait for the next game."
  });

 const tickets=q.body.tickets;
 const stake=Number(q.body.stake);

 if(!Array.isArray(tickets)||tickets.length<1)
  return r.status(400).json({
   success:false,
   message:"Add at least one ticket."
  });

 if(tickets.length>10000)
  return r.status(400).json({
   success:false,
   message:"Maximum 10,000 tickets."
  });

 if(!Number.isFinite(stake)||stake<=0)
  return r.status(400).json({
   success:false,
   message:"Invalid stake."
  });

 if(g.tickets.length+tickets.length>MAX_TICKETS)
  return r.status(400).json({
   success:false,
   message:"Maximum 10,000 tickets per game."
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

 if(total>u.balance)
  return r.status(400).json({
   success:false,
   message:"Insufficient balance."
  });

 u.balance-=total;

 const now=new Date().toISOString();

 tickets.forEach(numbers=>{
  g.tickets.push({
   ticketId:
    "T"+
    String(ticketCounter++)
    .padStart(8,"0"),

   username:q.user.username,
   round:g.round,
   game:g.game,
   numbers:[...numbers],
   stake,
   matches:0,
   prize:0,
   result:"PENDING",
   status:"PENDING",
   createdAt:now
  });
 });

 r.json({
  success:true,
  message:
   `${tickets.length} ticket${tickets.length===1?"":"s"} created.`,
  balance:u.balance,
  created:tickets.length,
  game:g.game
 });
});

app.post("/api/deposit",login,(q,r)=>{
 const name=String(q.body.name||"").trim();
 const transactionId=
  String(q.body.transactionId||"").trim();
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

 if(
  transactions.some(
   t=>
    t.type==="DEPOSIT"&&
    t.transactionId===transactionId
  )
 )
  return r.status(409).json({
   success:false,
   message:"Transaction ID already exists."
  });

 const t={
  id:
   "TX"+
   String(transactionCounter++)
   .padStart(8,"0"),
  type:"DEPOSIT",
  transactionId,
  name,
  username:q.user.username,
  amount,
  status:"PENDING",
  createdAt:new Date().toISOString()
 };

 transactions.unshift(t);

 r.json({
  success:true,
  message:"Deposit submitted for approval.",
  transaction:t
 });
});

app.post("/api/withdraw",login,(q,r)=>{
 const name=String(q.body.name||"").trim();
 const account=String(q.body.account||"").trim();
 const amount=Number(q.body.amount);
 const u=USERS[q.user.username];

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

 if(amount>u.balance)
  return r.status(400).json({
   success:false,
   message:"Insufficient balance."
  });

 u.balance-=amount;

 const t={
  id:
   "TX"+
   String(transactionCounter++)
   .padStart(8,"0"),
  type:"WITHDRAW",
  name,
  account,
  username:q.user.username,
  amount,
  status:"PENDING",
  createdAt:new Date().toISOString()
 };

 transactions.unshift(t);

 r.json({
  success:true,
  message:"Withdrawal submitted.",
  balance:u.balance,
  transaction:t
 });
});

app.get("/api/transactions",login,(q,r)=>{
 r.json({
  success:true,
  transactions:
   transactions
    .filter(t=>t.username===q.user.username)
    .slice(0,100)
 });
});

app.get("/api/admin/transactions",admin,(q,r)=>{
 r.json({
  success:true,
  transactions:transactions.slice(0,500)
 });
});

app.post(
 "/api/admin/transactions/:id/:action",
 admin,
 (q,r)=>{
  const t=transactions.find(
   x=>x.id===q.params.id
  );

  if(!t)
   return r.status(404).json({
    success:false,
    message:"Transaction not found."
   });

  if(t.status!=="PENDING")
   return r.status(400).json({
    success:false,
    message:"Already processed."
   });

  const u=USERS[t.username];

  if(q.params.action==="approve"){

   if(t.type==="DEPOSIT")
    u.balance+=t.amount;

   t.status="APPROVED";

  }else if(q.params.action==="reject"){

   if(t.type==="WITHDRAW")
    u.balance+=t.amount;

   t.status="REJECTED";

  }else{

   return r.status(400).json({
    success:false,
    message:"Invalid action."
   });
  }

  r.json({
   success:true,
   message:
    `Transaction ${t.status.toLowerCase()}.`
  });
 }
);

app.get("/api/tickets/history",login,(q,r)=>{
 r.json({
  success:true,
  tickets:
   games
    .flatMap(g=>g.tickets)
    .filter(
     t=>t.username===q.user.username
    )
    .slice(-500)
    .reverse()
 });
});

app.get("/api/admin/tickets/history",admin,(q,r)=>{
 r.json({
  success:true,
  tickets:
   games
    .flatMap(g=>g.tickets)
    .slice(-500)
    .reverse()
 });
});

app.get("/api/admin/status",admin,(q,r)=>{
 r.json({
  success:true,
  round,

  games:games.map(g=>({
   game:g.game,
   round:g.round,
   phase:g.phase,
   countdown:g.countdown,
   drawIndex:g.drawIndex,
   ticketCount:g.tickets.length,
   drawnNumbers:g.drawnNumbers
  })),

  totalTransactions:
   transactions.length
 });
});

app.post("/api/game/reset",admin,(q,r)=>{
 games=[];
 gameNumber=0;
 round=1;
 ticketCounter=1;

 Object.values(USERS).forEach(u=>{
  if(u.role==="customer")
   u.balance=0
 });

 createGame();

 r.json({
  success:true,
  message:"Game reset."
 });
});

app.listen(PORT,"0.0.0.0",()=>{
 console.log("================================");
 console.log("🎱 GLADY KENO BACKEND");
 console.log("60 SECOND BETTING");
 console.log("1 SECOND BETWEEN NUMBERS");
 console.log("20 NUMBERS DRAWN");
 console.log("4 SECOND WAIT AFTER NUMBER 20");
 console.log("ADD / REMOVE TICKETS ENABLED");
 console.log("================================");
});
