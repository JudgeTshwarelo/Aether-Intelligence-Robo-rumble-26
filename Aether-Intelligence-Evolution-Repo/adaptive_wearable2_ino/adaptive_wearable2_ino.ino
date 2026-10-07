/*
 * ============================================================
 *  AETHER WEARABLE — ESP32 EDGE NODE  (CLEAN BUILD)
 * ============================================================
 *  BTN Mankweng  → GPIO 25      GREEN LED  → GPIO 18
 *  BTN Seshego   → GPIO 26      YELLOW LED → GPIO 19
 *  BTN Polokwane → GPIO 27      RED LED    → GPIO 21
 *                               BUZZER     → GPIO 23
 *
 *  Buttons: GPIO ↔ button ↔ GND   (INPUT_PULLUP, no resistor needed)
 *  LEDs:    GPIO → 220Ω → LED anode → LED cathode → GND
 *
 *  Open the Serial Monitor at 115200 to see the IP.
 *  Visit http://<that-ip> on any device on the same Wi-Fi.
 * ============================================================
 */

#include <WiFi.h>
#include <WebServer.h>

// ---------- WIFI ----------
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ---------- PINS ----------
#define BTN_MANKWENG   25
#define BTN_SESHEGO    26
#define BTN_POLOKWANE  27

#define GREEN_LED      18
#define YELLOW_LED     19
#define RED_LED        21
#define BUZZER         23

// ---------- SERVER ----------
WebServer server(80);

// ---------- EVENT ----------
struct Event {
  String device;
  String location;
  String person;
  int    heartRate;
  String status;
  String eventName;
  unsigned long seq;
  bool   valid;
};

Event latestEvent = {"", "", "", 0, "", "", 0, false};
unsigned long eventSeq = 0;

// ---------- BUTTON STATE ----------
bool lastMankweng  = HIGH;
bool lastSeshego   = HIGH;
bool lastPolokwane = HIGH;
unsigned long lastPressMs = 0;
const unsigned long DEBOUNCE_MS = 400;

// ---------- BLINK STATE ----------
unsigned long blinkUntil  = 0;
unsigned long lastBlinkMs = 0;
bool          blinkState  = false;

// ============================================================
// HTML DASHBOARD
// ============================================================
const char DASHBOARD_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AETHER | Emergency Intelligence</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
       background:radial-gradient(circle at top,#10243b,#050a10 70%);
       color:#fff;min-height:100vh;overflow-x:hidden}
  header{height:70px;display:flex;align-items:center;justify-content:space-between;
         padding:0 30px;background:rgba(5,10,16,.9);
         border-bottom:1px solid rgba(255,255,255,.1);
         position:sticky;top:0;z-index:100;backdrop-filter:blur(10px)}
  .logo{font-size:22px;font-weight:700;letter-spacing:3px}
  .logo span{color:#00d9ff}
  .system-status{display:flex;align-items:center;gap:10px;
                 font-size:12px;color:#8da5b8;letter-spacing:1px}
  .status-dot{width:9px;height:9px;border-radius:50%;background:#00ff88;
              box-shadow:0 0 12px #00ff88;animation:pulse 2s infinite}
  @keyframes pulse{50%{opacity:.4}}
  main{padding:30px;max-width:1400px;margin:auto}
  .title h1{font-size:30px;letter-spacing:1px;margin-bottom:6px}
  .title p{color:#7f94a6;font-size:14px;margin-bottom:25px}

  /* MANUAL TEST BUTTONS */
  .test-bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:25px;
            padding:14px;border-radius:12px;
            background:rgba(8,17,27,.6);border:1px solid rgba(255,255,255,.06)}
  .test-bar span{color:#7f94a6;font-size:12px;letter-spacing:1px;
                 align-self:center;margin-right:8px}
  .test-btn{padding:8px 14px;border-radius:8px;border:1px solid rgba(0,217,255,.4);
            background:rgba(0,217,255,.08);color:#00d9ff;font-size:12px;
            cursor:pointer;letter-spacing:1px;transition:.2s;font-weight:600}
  .test-btn:hover{background:rgba(0,217,255,.2)}

  .locations{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}
  .location-card{background:rgba(12,25,39,.85);border:1px solid rgba(255,255,255,.08);
                 border-radius:15px;padding:22px;min-height:190px;transition:.35s;position:relative}
  .location-card.active{border-color:#ff3344;box-shadow:0 0 30px rgba(255,50,70,.35)}
  .location-name{font-size:20px;font-weight:700;margin-bottom:14px}
  .location-status{display:inline-block;padding:5px 12px;border-radius:20px;
                   font-size:11px;letter-spacing:1px;
                   background:rgba(0,255,136,.12);color:#00ff88;
                   margin-bottom:15px;transition:.3s}
  .location-status.alert{background:rgba(255,50,70,.15);color:#ff3344}
  .person{color:#b7c7d5;font-size:14px;margin-bottom:10px}
  .heart{font-size:32px;font-weight:700}
  .heart span{font-size:13px;color:#7f94a6;font-weight:400}
  .device{position:absolute;bottom:15px;right:18px;
          font-size:10px;color:#51697d;letter-spacing:1px}

  #alertContainer{position:fixed;top:90px;right:25px;width:340px;z-index:9999}
  .alert{background:rgba(10,17,25,.97);border-radius:14px;padding:20px;
         margin-bottom:15px;border-left:5px solid #ff3344;
         box-shadow:0 15px 50px rgba(0,0,0,.65);
         animation:slideIn .35s cubic-bezier(.2,.9,.3,1.2)}
  @keyframes slideIn{from{transform:translateX(120%);opacity:0}
                     to{transform:translateX(0);opacity:1}}
  .alert-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
  .alert-title{color:#ff3344;font-weight:700;letter-spacing:1px;font-size:13px}
  .close{cursor:pointer;color:#8194a5;font-size:22px;line-height:1}
  .close:hover{color:#fff}
  .alert-location{font-size:22px;font-weight:700;margin-bottom:14px}
  .alert-row{display:flex;justify-content:space-between;padding:7px 0;font-size:13px;
             border-bottom:1px solid rgba(255,255,255,.06)}
  .alert-row:last-child{border-bottom:none}
  .alert-row span:first-child{color:#71889a}
  .critical{color:#ff3344;font-weight:700}
  .emergency{color:#ff8c42;font-weight:700}

  .event-section{margin-top:35px}
  .event-section h2{font-size:16px;margin-bottom:14px;letter-spacing:2px;color:#8da5b8}
  .event-log{background:rgba(8,17,27,.8);border-radius:12px;
             border:1px solid rgba(255,255,255,.07);padding:8px 15px;
             max-height:240px;overflow-y:auto}
  .log-item{display:flex;justify-content:space-between;padding:10px 0;
            border-bottom:1px solid rgba(255,255,255,.05);font-size:13px}
  .log-item:last-child{border-bottom:none}
  .log-time{color:#536b7e;font-size:12px}
  .log-event{color:#ff6674}

  footer{text-align:center;color:#405667;font-size:11px;padding:30px;letter-spacing:1px}

  .conn{font-size:11px;padding:4px 10px;border-radius:10px;
        background:rgba(0,255,136,.1);color:#00ff88;margin-left:10px}
  .conn.bad{background:rgba(255,50,70,.1);color:#ff3344}

  @media(max-width:500px){
    #alertContainer{right:10px;left:10px;width:auto}
    main{padding:18px}
  }
</style>
</head>
<body>

<header>
  <div class="logo">AETHER <span>INTELLIGENCE</span></div>
  <div class="system-status">
    <div class="status-dot"></div>
    SYSTEM ONLINE
    <span class="conn" id="connState">...</span>
  </div>
</header>

<main>
  <div class="title">
    <h1>Emergency Intelligence Network</h1>
    <p>Wearable telemetry monitoring layer — ESP32 Edge Node</p>
  </div>

  <div class="test-bar">
    <span>TEST:</span>
    <button class="test-btn" onclick="testLoc('mankweng')">MANKWENG</button>
    <button class="test-btn" onclick="testLoc('seshego')">SESHEGO</button>
    <button class="test-btn" onclick="testLoc('polokwane')">POLOKWANE</button>
  </div>

  <div class="locations">
    <div class="location-card" id="card-Mankweng">
      <div class="location-name">Mankweng</div>
      <div class="location-status" id="status-Mankweng">MONITORING</div>
      <div class="person" id="person-Mankweng">No active patient</div>
      <div class="heart" id="heart-Mankweng">-- <span>BPM</span></div>
      <div class="device">WEARABLE-01</div>
    </div>
    <div class="location-card" id="card-Seshego">
      <div class="location-name">Seshego</div>
      <div class="location-status" id="status-Seshego">MONITORING</div>
      <div class="person" id="person-Seshego">No active patient</div>
      <div class="heart" id="heart-Seshego">-- <span>BPM</span></div>
      <div class="device">WEARABLE-02</div>
    </div>
    <div class="location-card" id="card-Polokwane">
      <div class="location-name">Polokwane</div>
      <div class="location-status" id="status-Polokwane">MONITORING</div>
      <div class="person" id="person-Polokwane">No active patient</div>
      <div class="heart" id="heart-Polokwane">-- <span>BPM</span></div>
      <div class="device">WEARABLE-03</div>
    </div>
  </div>

  <div class="event-section">
    <h2>LIVE EVENT STREAM</h2>
    <div class="event-log" id="eventLog">
      <div class="log-item">
        <span>Aether monitoring system initialized</span>
        <span class="log-time">ONLINE</span>
      </div>
    </div>
  </div>
</main>

<footer>AETHER INTELLIGENCE — Emergency Intelligence as Infrastructure</footer>

<div id="alertContainer"></div>

<script>
let lastSeq = 0;
let audioCtx = null;
let online = false;

document.addEventListener('click', () => {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch(e) {}
  }
}, { once: true });

const connEl = document.getElementById('connState');

async function poll() {
  try {
    const res = await fetch('/api/latest', { cache: 'no-store' });
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    setConn(true);

    if (!data.valid) return;
    if (data.seq === lastSeq) return;

    lastSeq = data.seq;
    processEvent(data);
  } catch (e) {
    setConn(false);
  }
}

function setConn(isOk) {
  if (isOk === online) return;
  online = isOk;
  connEl.textContent = isOk ? 'ONLINE' : 'OFFLINE';
  connEl.classList.toggle('bad', !isOk);
}

function processEvent(data) {
  updateLocationCard(data);
  createAlert(data);
  addEventLog(data);
  playAlertSound();
}

function updateLocationCard(data) {
  const loc = data.location;
  const personEl = document.getElementById('person-' + loc);
  const heartEl  = document.getElementById('heart-' + loc);
  const statusEl = document.getElementById('status-' + loc);
  const cardEl   = document.getElementById('card-' + loc);
  if (!personEl) return;

  personEl.innerText = data.person;
  heartEl.innerHTML  = data.heartRate + ' <span>BPM</span>';
  statusEl.innerText = data.status;
  statusEl.classList.add('alert');
  cardEl.classList.add('active');

  setTimeout(() => cardEl.classList.remove('active'), 5000);
}

function createAlert(data) {
  const container = document.getElementById('alertContainer');
  const alert = document.createElement('div');
  alert.className = 'alert';

  const statusClass = data.status === 'EMERGENCY' ? 'emergency' : 'critical';
  const timeStr = new Date().toLocaleTimeString();

  alert.innerHTML = `
    <div class="alert-header">
      <div class="alert-title">&#9888; AETHER MEDICAL ALERT</div>
      <div class="close">&times;</div>
    </div>
    <div class="alert-location">${data.location}</div>
    <div class="alert-row"><span>Patient</span><strong>${data.person}</strong></div>
    <div class="alert-row"><span>Heart Rate</span><strong>${data.heartRate} BPM</strong></div>
    <div class="alert-row"><span>Status</span><strong class="${statusClass}">${data.status}</strong></div>
    <div class="alert-row"><span>Event</span><strong>${data.eventName}</strong></div>
    <div class="alert-row"><span>Device</span><strong>${data.device}</strong></div>
    <div class="alert-row"><span>Time</span><strong>${timeStr}</strong></div>
  `;

  alert.querySelector('.close').addEventListener('click', () => alert.remove());
  container.appendChild(alert);

  setTimeout(() => { if (alert.parentElement) alert.remove(); }, 12000);
}

function addEventLog(data) {
  const log = document.getElementById('eventLog');
  const item = document.createElement('div');
  item.className = 'log-item';
  const timeStr = new Date().toLocaleTimeString();
  item.innerHTML = `
    <span><strong>${data.location}</strong> &mdash; ${data.eventName}</span>
    <span class="log-event">${timeStr}</span>
  `;
  log.prepend(item);
  while (log.children.length > 20) log.removeChild(log.lastChild);
}

function playAlertSound() {
  try {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    osc.type = 'square';
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);
  } catch (e) {}
}

// ---- Manual test (bypasses buttons) ----
function testLoc(loc) {
  fetch('/api/test?loc=' + loc).catch(() => {});
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
  }
}

setInterval(poll, 500);
poll();
</script>

</body>
</html>
)HTML";

// ============================================================
// ROUTES
// ============================================================
void handleRoot() {
  server.sendHeader("Cache-Control", "no-store");
  server.send_P(200, "text/html", DASHBOARD_HTML);
}

void handleLatest() {
  String json;
  json.reserve(320);

  if (!latestEvent.valid) {
    json = F("{\"valid\":false}");
  } else {
    json  = "{";
    json += "\"valid\":true,";
    json += "\"seq\":"         + String(latestEvent.seq) + ",";
    json += "\"device\":\""    + latestEvent.device     + "\",";
    json += "\"location\":\""  + latestEvent.location   + "\",";
    json += "\"person\":\""    + latestEvent.person     + "\",";
    json += "\"heartRate\":"   + String(latestEvent.heartRate) + ",";
    json += "\"status\":\""    + latestEvent.status     + "\",";
    json += "\"eventName\":\"" + latestEvent.eventName  + "\"";
    json += "}";
  }

  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", json);
}

// Manual test route: /api/test?loc=mankweng|seshego|polokwane
void handleTest() {
  String loc = server.arg("loc");
  loc.toLowerCase();

  if (loc == "mankweng") {
    storeEvent("WEARABLE-01", "Mankweng", "Thabo Mokoena",
               128, "CRITICAL", "HIGH_HEART_RATE");
    startBlink(3000);
  } else if (loc == "seshego") {
    storeEvent("WEARABLE-02", "Seshego", "Naledi Maseko",
               76, "EMERGENCY", "SOS");
    startBlink(3000);
  } else if (loc == "polokwane") {
    storeEvent("WEARABLE-03", "Polokwane", "Kabelo Molefe",
               42, "CRITICAL", "LOW_HEART_RATE");
    startBlink(3000);
  } else {
    server.send(400, "text/plain", "unknown loc");
    return;
  }

  server.send(200, "text/plain", "ok");
}

void handleNotFound() {
  server.send(404, "text/plain", "Aether node: route not found");
}

// ============================================================
// STORE EVENT
// ============================================================
void storeEvent(const char* device, const char* location, const char* person,
                int hr, const char* status, const char* eventName) {
  eventSeq++;

  latestEvent.device     = device;
  latestEvent.location   = location;
  latestEvent.person     = person;
  latestEvent.heartRate  = hr;
  latestEvent.status     = status;
  latestEvent.eventName  = eventName;
  latestEvent.seq        = eventSeq;
  latestEvent.valid      = true;

  Serial.print("[EVENT #");
  Serial.print(eventSeq);
  Serial.print("] ");
  Serial.print(location);
  Serial.print(" | ");
  Serial.print(person);
  Serial.print(" | HR=");
  Serial.print(hr);
  Serial.print(" | ");
  Serial.print(status);
  Serial.print(" | ");
  Serial.println(eventName);
}

// ============================================================
// LED HELPERS
// ============================================================
void idleLeds() {
  digitalWrite(GREEN_LED,  HIGH);
  digitalWrite(YELLOW_LED, LOW);
  digitalWrite(RED_LED,    LOW);
  noTone(BUZZER);
}

void startBlink(unsigned long durationMs) {
  blinkUntil  = millis() + durationMs;
  lastBlinkMs = millis();
  blinkState  = false;

  // Green off during emergency
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(YELLOW_LED, LOW);
  digitalWrite(RED_LED, HIGH);
}

void updateBlink() {
  if (blinkUntil == 0) return;

  if ((long)(millis() - blinkUntil) >= 0) {
    blinkUntil = 0;
    blinkState = false;
    idleLeds();
    return;
  }

  if (millis() - lastBlinkMs >= 250) {
    lastBlinkMs = millis();
    blinkState = !blinkState;

    digitalWrite(RED_LED, blinkState ? HIGH : LOW);
    if (blinkState) tone(BUZZER, 1200);
    else            noTone(BUZZER);
  }
}

// ============================================================
// SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.println();
  Serial.println("============================================");
  Serial.println(" AETHER WEARABLE DIGITAL TWIN — CLEAN BUILD");
  Serial.println("============================================");

  // Outputs
  pinMode(GREEN_LED,  OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(RED_LED,    OUTPUT);
  pinMode(BUZZER,     OUTPUT);

  // Idle state
  idleLeds();

  // Buttons
  pinMode(BTN_MANKWENG,  INPUT_PULLUP);
  pinMode(BTN_SESHEGO,   INPUT_PULLUP);
  pinMode(BTN_POLOKWANE, INPUT_PULLUP);

  // WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 25000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi connected!");
    Serial.print("Open this URL on your phone/PC: http://");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi FAILED — check SSID/password");
  }

  server.on("/",           handleRoot);
  server.on("/api/latest", handleLatest);
  server.on("/api/test",   handleTest);
  server.onNotFound(handleNotFound);

  server.begin();
  Serial.println("Web server started on port 80");
  Serial.println("Press a button and watch the browser.");
  Serial.println("============================================");
}

// ============================================================
// LOOP
// ============================================================
void loop() {
  server.handleClient();
  updateBlink();

  bool mankweng  = digitalRead(BTN_MANKWENG);
  bool seshego   = digitalRead(BTN_SESHEGO);
  bool polokwane = digitalRead(BTN_POLOKWANE);

  unsigned long now = millis();

  if (lastMankweng == HIGH && mankweng == LOW && now - lastPressMs > DEBOUNCE_MS) {
    lastPressMs = now;
    storeEvent("WEARABLE-01", "Mankweng", "Thabo Mokoena",
               128, "CRITICAL", "HIGH_HEART_RATE");
    startBlink(3000);
  }

  if (lastSeshego == HIGH && seshego == LOW && now - lastPressMs > DEBOUNCE_MS) {
    lastPressMs = now;
    storeEvent("WEARABLE-02", "Seshego", "Naledi Maseko",
               76, "EMERGENCY", "SOS");
    startBlink(3000);
  }

  if (lastPolokwane == HIGH && polokwane == LOW && now - lastPressMs > DEBOUNCE_MS) {
    lastPressMs = now;
    storeEvent("WEARABLE-03", "Polokwane", "Kabelo Molefe",
               42, "CRITICAL", "LOW_HEART_RATE");
    startBlink(3000);
  }

  lastMankweng  = mankweng;
  lastSeshego   = seshego;
  lastPolokwane = polokwane;
}