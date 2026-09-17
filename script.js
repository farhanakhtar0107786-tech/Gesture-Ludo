const $ = id => document.getElementById(id);
const board = $("board");
const ctx = board.getContext("2d");
const video = $("video");

const CELL = 50;
const HOLD_MS = 1100;
const CLEAR_MS = 550;

// Clockwise outer track: [row, column].
const PATH = [
  [6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
  [0,7],[0,8],
  [1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
  [14,7],[14,6],
  [13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
  [7,0],[6,0]
];

const SAFE = new Set([0,8,13,21,26,34,39,47]);
const START = [0,26];

const LANES = [
  [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
  [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]]
];

const HOMES = [
  [[2,2],[2,4],[4,2],[4,4]],
  [[10,10],[10,12],[12,10],[12,12]]
];

const COLORS = ["#e64b60","#159c71"];
const DARK = ["#a52035","#076348"];

// -1: yard; 0..50: outer track; 51..56: home lane.
// 56 is the finished position; an exact dice result is required.
let pieces, player, roll, phase, clearTarget, winner;
let epoch = 0;
let validHuman = [];
let logs = [];

let cameraReady = false;
let handLandmarker = null;
let stream = null;
let loopStarted = false;
let lastVideoTime = -1;
let lastInference = 0;

let candidate = null;
let candidateSince = 0;
let absentSince = null;

function addLog(message) {
  logs.unshift(message);
  logs = logs.slice(0,30);
  $("log").replaceChildren();
  for (const text of logs) {
    const div = document.createElement("div");
    div.className = "log-item";
    div.textContent = text;
    $("log").append(div);
  }
}

function resetGesture() {
  candidate = null;
  candidateSince = 0;
  absentSince = null;
  $("holdBar").style.width = "0%";
}

function requireClear(next) {
  phase = "CLEAR";
  clearTarget = next;
  resetGesture();
  updateUI();
}

function resetGame() {
  epoch++;
  pieces = [
    [-1,-1,-1,-1],
    [-1,-1,-1,-1]
  ];
  player = 0;
  roll = 0;
  winner = null;
  validHuman = [];
  logs = [];
  phase = cameraReady ? "CLEAR" : "READY";
  clearTarget = "DICE";
  resetGesture();
  addLog("New game. Your red pieces move first.");
  updateUI();
  draw();
}

function validMoves(who, dice) {
  return pieces[who].flatMap((position,index) => {
    if (position === 56) return [];
    if (position === -1) return dice === 6 ? [index] : [];
    return position + dice <= 56 ? [index] : [];
  });
}

function globalIndex(who, progress) {
  return (START[who] + progress) % 52;
}

function predictedPosition(who,index,dice) {
  const old = pieces[who][index];
  return old === -1 ? 0 : old + dice;
}

function captureCount(who, destination) {
  if (destination > 50) return 0;
  const square = globalIndex(who,destination);
  if (SAFE.has(square)) return 0;

  return pieces[1-who].filter(position =>
    position >= 0 &&
    position <= 50 &&
    globalIndex(1-who,position) === square
  ).length;
}

function movePiece(who,index) {
  if (!validMoves(who,roll).includes(index)) return false;

  const next = predictedPosition(who,index,roll);
  pieces[who][index] = next;

  const name = who === 0 ? "You" : "Computer";
  addLog(`${name}: piece ${index+1} moved with ${roll}.`);

  if (next <= 50) {
    const square = globalIndex(who,next);
    if (!SAFE.has(square)) {
      pieces[1-who].forEach((position,otherIndex) => {
        if (
          position >= 0 && position <= 50 &&
          globalIndex(1-who,position) === square
        ) {
          pieces[1-who][otherIndex] = -1;
          addLog(`${name} captured opponent piece ${otherIndex+1}!`);
        }
      });
    }

  }

  if (next === 56) {
    addLog(`${name}: piece ${index+1} reached home!`);
  }

  if (pieces[who].every(position => position === 56)) {
    winner = who;
    phase = "OVER";
    validHuman = [];
    addLog(who === 0 ? "🏆 You won!" : "🏆 Computer won!");
    updateUI();
    draw();
    return true;
  }

  finishTurn(who);
  return true;
}

function finishTurn(who) {
  validHuman = [];
  if (roll === 6) {
    addLog(who === 0 ? "Six! You get another turn." : "Computer gets another turn.");
    player = who;
  } else {
    player = 1-who;
  }

  if (player === 0) {
    requireClear("DICE");
  } else {
    computerTurn();
  }

  updateUI();
  draw();
}

function delayTask(callback, ms) {
  const generation = epoch;
  setTimeout(() => {
    if (generation === epoch && winner === null) callback();
  }, ms);
}

function chooseHumanDice(number) {
  roll = number === 0 ? 6 : number;
  validHuman = validMoves(0,roll);
  addLog(`Your dice: ${roll}.`);

  if (!validHuman.length) {
    phase = "BUSY";
    updateUI();
    draw();
    delayTask(() => finishTurn(0),1100);
    return;
  }

  requireClear("PIECE");
  draw();
}

function chooseHumanPiece(number) {
  const index = number - 1;

  if (!validHuman.includes(index)) {
    addLog(`Piece ${number || "?"} cannot move. Choose a gold-outlined piece.`);
    requireClear("PIECE");
    return;
  }

  phase = "BUSY";
  resetGesture();
  movePiece(0,index);
}

function computerTurn() {
  phase = "COMPUTER";
  resetGesture();
  updateUI();

  delayTask(() => {
    roll = Math.floor(Math.random()*6)+1;
    addLog(`Computer dice: ${roll}.`);
    updateUI();
    const moves = validMoves(1,roll);

    if (!moves.length) {
      addLog("Computer has no valid move.");
      delayTask(() => finishTurn(1),900);
      return;
    }

    // Simple opponent: prefer finishing, captures and leaving the yard.
    const ranked = moves.map(index => {
      const next = predictedPosition(1,index,roll);
      let score = next;
      if (next === 56) score += 1000;
      score += captureCount(1,next)*300;
      if (pieces[1][index] === -1) score += 70;
      if (next <= 50 && SAFE.has(globalIndex(1,next))) score += 20;
      return {index,score:score+Math.random()*4};
    }).sort((a,b) => b.score-a.score);

    delayTask(() => movePiece(1,ranked[0].index),1000);
  },1100);
}

function updateUI() {
  $("dice").textContent = roll || "–";
  $("score").textContent =
    `Your finished pieces: ${pieces[0].filter(p=>p===56).length}/4`
    + ` · Computer: ${pieces[1].filter(p=>p===56).length}/4`;

  $("turn").textContent = winner !== null
    ? "GAME OVER"
    : player === 0 ? "YOUR TURN 🔴" : "COMPUTER 🟢";

  let message = "";

  switch (phase) {
    case "READY":
      message = "Start camera to play.";
      break;
    case "CLEAR":
      message = clearTarget === "DICE"
        ? "Remove your hand. Next: choose your dice."
        : `Dice ${roll}: remove your hand, then choose a piece.`;
      break;
    case "DICE":
      message = "Show 1–5 fingers, or a fist for 6.";
      break;
    case "PIECE":
      message = `Show piece number: ${validHuman.map(i=>i+1).join(", ")}.`;
      break;
    case "COMPUTER":
      message = "Computer is playing…";
      break;
    case "BUSY":
      message = "No valid move. Passing turn…";
      break;
    case "OVER":
      message = winner === 0
        ? "🏆 You won! Restart to play again."
        : "🤖 Computer won! Try again.";
      break;
  }
  $("instruction").textContent = message;
}

function cell(row,col,color) {
  ctx.fillStyle = color;
  ctx.fillRect(col*CELL,row*CELL,CELL,CELL);
  ctx.strokeStyle = "#cad3df";
  ctx.lineWidth = 1;
  ctx.strokeRect(col*CELL,row*CELL,CELL,CELL);
}

function yard(row,col,color,label) {
  ctx.fillStyle = color;
  ctx.fillRect(col*CELL,row*CELL,6*CELL,6*CELL);
  ctx.fillStyle = "#ffffffdd";
  ctx.fillRect((col+.8)*CELL,(row+.8)*CELL,4.4*CELL,4.4*CELL);
  ctx.fillStyle = color;
  ctx.font = "bold 17px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(label,(col+3)*CELL,(row+1.4)*CELL);
}

function positionOf(who,index) {
  const progress = pieces[who][index];
  if (progress === -1) return HOMES[who][index];
  if (progress <= 50) return PATH[globalIndex(who,progress)];
  return LANES[who][progress-51];
}

function draw() {
  ctx.clearRect(0,0,750,750);
  ctx.fillStyle = "#edf2f7";
  ctx.fillRect(0,0,750,750);

  yard(0,0,"#f6b7c1","YOU");
  yard(9,9,"#9bddc6","COMPUTER");
  yard(0,9,"#dce3ed","GESTURE");
  yard(9,0,"#dce3ed","LUDO");

  PATH.forEach(([r,c],index) => {
    cell(r,c,SAFE.has(index) ? "#fff1bd" : "#ffffff");
    if (SAFE.has(index)) {
      ctx.fillStyle = "#a78a35";
      ctx.font = "25px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("★",(c+.5)*CELL,(r+.5)*CELL);
    }
  });

  LANES.forEach((lane,who) => lane.forEach(([r,c],i) => {
    cell(r,c,who === 0 ? "#fac7cf" : "#b0ead6");
    if (i===5) {
      ctx.fillStyle = DARK[who];
      ctx.font = "12px system-ui";
      ctx.fillText("HOME",(c+.5)*CELL,(r+.5)*CELL);
    }
  }));

  const [sr,sc] = PATH[0];
  cell(sr,sc,"#f49aaa");
  const [gr,gc] = PATH[26];
  cell(gr,gc,"#71d6b2");

  ctx.fillStyle = "#27394f";
  ctx.fillRect(7*CELL,6*CELL,CELL,3*CELL);
  ctx.fillStyle = "white";
  ctx.font = "24px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("🏆",7.5*CELL,7.5*CELL);

  // Group pieces sharing a square so labels stay visible.
  const groups = new Map();

  for (let who=0;who<2;who++) {
    for (let i=0;i<4;i++) {
      const [r,c] = positionOf(who,i);
      const key = `${r},${c}`;
      if (!groups.has(key)) groups.set(key,[]);
      groups.get(key).push({who,index:i,r,c});
    }
  }

  for (const group of groups.values()) {
    const count = group.length;

    group.forEach((piece,k) => {
      let dx=0,dy=0;
      if (count>1) {
        const columns = count<=4 ? 2 : 3;
        const rows = Math.ceil(count/columns);
        dx = (k%columns-(columns-1)/2)*15;
        dy = (Math.floor(k/columns)-(rows-1)/2)*15;
      }

      const x=(piece.c+.5)*CELL+dx;
      const y=(piece.r+.5)*CELL+dy;
      const radius=count===1 ? 18 : count<=4 ? 11 : 8;
      const highlighted =
        piece.who===0 &&
        validHuman.includes(piece.index) &&
        (phase==="PIECE" || (phase==="CLEAR" && clearTarget==="PIECE"));

      ctx.beginPath();
      ctx.arc(x,y,radius+(highlighted?4:0),0,Math.PI*2);
      ctx.fillStyle = highlighted ? "#ffbd28" : "#ffffff";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x,y,radius-2,0,Math.PI*2);
      ctx.fillStyle = COLORS[piece.who];
      ctx.fill();
      ctx.strokeStyle = DARK[piece.who];
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "white";
      ctx.font = `bold ${count===1?17:count<=4?12:10}px system-ui`;
      ctx.fillText(String(piece.index+1),x,y+.5);
    });
  }
}

// Hand landmark helpers.
function distance(a,b) {
  return Math.hypot(a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0));
}

function angle(a,b,c) {
  const u=[a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0)];
  const v=[c.x-b.x,c.y-b.y,(c.z||0)-(b.z||0)];
  const dot=u.reduce((sum,n,i)=>sum+n*v[i],0);
  const length=Math.hypot(...u)*Math.hypot(...v);
  if (!length) return 0;
  return Math.acos(Math.max(-1,Math.min(1,dot/length)))*180/Math.PI;
}

function countFingers(points) {
  let count=0;

  // Index, middle, ring and little finger.
  for (const [mcp,pip,dip,tip] of [
    [5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]
  ]) {
    const straight =
      angle(points[mcp],points[pip],points[dip])>155 &&
      angle(points[pip],points[dip],points[tip])>150;

    const outward =
      distance(points[tip],points[0]) >
      distance(points[pip],points[0])*1.10;

    if (straight && outward) count++;
  }

  // Thumb: straight and separated from the index-finger base.
  const thumbOpen =
    angle(points[1],points[2],points[3])>145 &&
    angle(points[2],points[3],points[4])>150 &&
    distance(points[4],points[5]) >
    distance(points[3],points[5])*1.25;

  if (thumbOpen) count++;
  return count;
}

function processGesture(number,now) {
  if (phase === "CLEAR") {
    candidate=null;
    $("holdBar").style.width="0%";

    if (number===null) {
      if (absentSince===null) absentSince=now;

      if (now-absentSince >= CLEAR_MS) {
        phase=clearTarget;
        resetGesture();
        updateUI();
        draw();
      }
    } else {
      absentSince=null;
    }
    return;
  }

  if (phase!=="DICE" && phase!=="PIECE") {
    candidate=null;
    $("holdBar").style.width="0%";
    return;
  }

  if (number===null) {
    candidate=null;
    $("holdBar").style.width="0%";
    return;
  }

  if (phase==="PIECE" && (number<1 || number>4)) {
    candidate=null;
    $("holdBar").style.width="0%";
    $("handLabel").textContent="Piece selection: show 1, 2, 3 or 4 fingers.";
    return;
  }

  if (candidate!==number) {
    candidate=number;
    candidateSince=now;
  }

  const progress=Math.min(1,(now-candidateSince)/HOLD_MS);
  $("holdBar").style.width=`${progress*100}%`;

  if (progress>=1) {
    const chosen=number;
    resetGesture();

    if (phase==="DICE") chooseHumanDice(chosen);
    else chooseHumanPiece(chosen);
  }
}

function cameraLoop(now) {
  requestAnimationFrame(cameraLoop);

  if (!cameraReady || !handLandmarker ||
      video.readyState<2 || document.hidden) return;

  if (now-lastInference<65 || video.currentTime===lastVideoTime) return;

  lastInference=now;
  lastVideoTime=video.currentTime;

  try {
    const result=handLandmarker.detectForVideo(video,now);
    const hand=result.landmarks?.[0];
    const number=hand ? countFingers(hand) : null;

    $("handLabel").textContent = hand
      ? number===0 ? "Detected: closed fist ✊" : `Detected: ${number} fingers`
      : "No hand detected";

    processGesture(number,now);
  } catch(error) {
    cameraReady=false;
    resetGesture();
    $("cameraStatus").textContent =
      "Tracking stopped. Press Retry Camera. " + error.message;
    $("start").disabled=false;
    $("start").textContent="Retry Camera";
  }
}

async function startCamera() {
  $("start").disabled=true;
  $("cameraStatus").textContent="Loading hand tracker…";

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Open this page on localhost or HTTPS.");
    }

    if (!handLandmarker) {
      const {FilesetResolver,HandLandmarker} = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm"
      );

      const vision=await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );

      handLandmarker=await HandLandmarker.createFromOptions(vision,{
        baseOptions:{
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
        },
        runningMode:"VIDEO",
        numHands:1,
        minHandDetectionConfidence:0.65,
        minHandPresenceConfidence:0.65,
        minTrackingConfidence:0.65
      });
    }

    $("cameraStatus").textContent="Allow camera permission…";

    if (stream) stream.getTracks().forEach(track=>track.stop());

    stream=await navigator.mediaDevices.getUserMedia({
      video:{
        facingMode:"user",
        width:{ideal:640},
        height:{ideal:480}
      },
      audio:false
    });

    video.srcObject=stream;
    await video.play();

    cameraReady=true;
    lastVideoTime=-1;
    lastInference=0;
    resetGesture();

    $("cameraStatus").textContent =
      "Camera ready. Use one hand in good lighting.";
    $("start").textContent="Camera Running";

    if (phase==="READY") requireClear("DICE");

    if (!loopStarted) {
      loopStarted=true;
      requestAnimationFrame(cameraLoop);
    }
  } catch(error) {
    cameraReady=false;
    if (stream) stream.getTracks().forEach(track=>track.stop());
    $("start").disabled=false;
    $("start").textContent="Retry Camera";
    $("cameraStatus").textContent =
      "Could not start: " + error.message +
      " Check camera permission, internet and localhost/HTTPS.";
  }
}

$("start").addEventListener("click",startCamera);
$("reset").addEventListener("click",resetGame);

document.addEventListener("visibilitychange",resetGesture);
window.addEventListener("pagehide",()=>{
  if(stream) stream.getTracks().forEach(track=>track.stop());
});

resetGame();
