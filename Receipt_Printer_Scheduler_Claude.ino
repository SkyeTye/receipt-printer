// ============================================================
// Receipt Printer — ESP8266 Polling Client
// ============================================================
// This firmware connects to a cloud server and polls for print
// jobs every 30 seconds. All scheduling and logic live on the
// server; this device just prints what it receives.
//
// Required libraries (install via Arduino Library Manager):
//   - NTPClient        by Fabrice Weinberg
//   - ArduinoJson      by Benoit Blanchon  (v6.x)
//   - TimeLib          by Paul Stoffregen
// ============================================================

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <SoftwareSerial.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <TimeLib.h>
#include <ArduinoJson.h>

// ============================================================
// Configuration — fill in before flashing
// ============================================================
const char* WIFI_SSID     = "1329 W 36th Resident";
const char* WIFI_PASSWORD = "k1m4ucio";
const char* SERVER_URL    = "https://YOUR-APP.up.railway.app"; // no trailing slash

// Timezone offset in seconds (PST = -28800, PDT = -25200)
const long UTC_OFFSET = -28800;

// How often to poll for new jobs (milliseconds)
const unsigned long POLL_INTERVAL = 30000;

// ============================================================
// Hardware
// ============================================================
SoftwareSerial printer(D4, D3); // TX=D4, RX=D3
const int MAX_CHARS_PER_LINE = 30;

// ============================================================
// Time
// ============================================================
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", UTC_OFFSET, 60000);

// ============================================================
// State
// ============================================================
unsigned long lastPoll = 0;

// ============================================================
// Forward declarations
// ============================================================
void connectToWiFi();
void pollForJobs();
void confirmJob(int jobId);
void printJob(const String& content);
void initializePrinter();
void beginPrintJob();
String getFormattedDateTime();
void setInverse(bool enable);
void setBold(bool on);
void setDoubleHeight(bool on);
void printLineSafe(const String& s);
void advancePaper(int lines);
void printWrappedUpsideDown(String text);

// ============================================================
// Setup
// ============================================================
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== Receipt Printer Starting ===");

  initializePrinter();
  connectToWiFi();

  timeClient.begin();
  timeClient.update();

  // Poll immediately on boot to flush any queued jobs
  if (WiFi.status() == WL_CONNECTED) {
    pollForJobs();
  }

  Serial.println("=== Setup complete ===");
}

// ============================================================
// Loop
// ============================================================
void loop() {
  timeClient.update();

  unsigned long now = millis();
  if (now - lastPoll >= POLL_INTERVAL) {
    lastPoll = now;
    if (WiFi.status() == WL_CONNECTED) {
      pollForJobs();
    } else {
      Serial.println("WiFi lost — reconnecting...");
      connectToWiFi();
    }
  }

  delay(10);
}

// ============================================================
// WiFi
// ============================================================
void connectToWiFi() {
  Serial.print("Connecting to ");
  Serial.println(WIFI_SSID);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(1000);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected. IP: " + WiFi.localIP().toString());
    lastPoll = 0; // trigger an immediate poll after reconnect
  } else {
    Serial.println("\nFailed to connect to WiFi");
  }
}

// ============================================================
// Polling
// ============================================================
void pollForJobs() {
  BearSSL::WiFiClientSecure client;
  client.setInsecure(); // skips cert verification — fine for personal use
  client.setTimeout(15);

  HTTPClient https;
  String url = String(SERVER_URL) + "/api/next-job";

  Serial.println("Polling " + url);

  if (!https.begin(client, url)) {
    Serial.println("HTTP begin failed");
    return;
  }

  https.setTimeout(15000);
  int code = https.GET();

  if (code != HTTP_CODE_OK) {
    Serial.println("Poll failed, HTTP " + String(code));
    https.end();
    return;
  }

  String payload = https.getString();
  https.end();

  // Parse JSON
  StaticJsonDocument<1024> doc;
  DeserializationError err = deserializeJson(doc, payload);

  if (err || !doc.containsKey("id")) {
    Serial.println("No pending jobs");
    return;
  }

  int jobId      = doc["id"].as<int>();
  String content = doc["content"].as<String>();

  Serial.println("Job #" + String(jobId) + " received");

  printJob(content);
  confirmJob(jobId);

  // Check immediately for more queued jobs
  delay(500);
  pollForJobs();
}

void confirmJob(int jobId) {
  BearSSL::WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(10);

  HTTPClient https;
  String url = String(SERVER_URL) + "/api/job-done/" + String(jobId);

  if (https.begin(client, url)) {
    https.addHeader("Content-Type", "application/json");
    int code = https.POST("");
    Serial.println("Confirmed job #" + String(jobId) + " (HTTP " + String(code) + ")");
    https.end();
  }
}

// ============================================================
// Printing
// ============================================================
void printJob(const String& content) {
  beginPrintJob();

  printWrappedUpsideDown(content);
  advancePaper(1);
  delay(100);

  String timestamp = getFormattedDateTime();
  setBold(true);
  setDoubleHeight(true);
  printLineSafe(timestamp);
  setDoubleHeight(false);
  setBold(false);

  advancePaper(2);

  Serial.println("Print complete");
}

void initializePrinter() {
  printer.begin(9600);
  delay(500);

  printer.write(0x1B); printer.write('@');   // reset
  delay(50);

  printer.write(0x1B); printer.write('7');   // print settings
  printer.write(15);
  printer.write(200);
  printer.write(200);

  printer.write(0x1B); printer.write('{'); printer.write(0x01); // upside-down mode

  Serial.println("Printer initialized");
}

void beginPrintJob() {
  printer.write(0x1B); printer.write('@');   // reset
  delay(50);

  printer.write(0x1B); printer.write('7');   // print settings
  printer.write(15);
  printer.write(200);
  printer.write(200);
  delay(10);

  printer.write(0x1B); printer.write('{'); printer.write(0x01);
  delay(10);

  setInverse(false);
  delay(10);
}

void setInverse(bool enable) {
  printer.write(0x1D); printer.write('B');
  printer.write(enable ? 1 : 0);
  delay(5);
}

void setBold(bool on) {
  printer.write(0x1B); printer.write('E');
  printer.write(on ? 1 : 0);
  delay(5);
}

void setDoubleHeight(bool on) {
  printer.write(0x1D); printer.write('!');
  printer.write(on ? 0x01 : 0x00);
  delay(5);
}

void printLineSafe(const String& s) {
  int i = 0;
  while (i < (int)s.length()) {
    int len = min(MAX_CHARS_PER_LINE, (int)s.length() - i);
    printer.print(s.substring(i, i + len));
    printer.write('\n');
    delay(20);
    i += len;
  }
  if (s.length() == 0) {
    printer.write('\n');
    delay(20);
  }
}

void advancePaper(int lines) {
  for (int i = 0; i < lines; i++) {
    printer.write(0x0A);
    delay(30);
  }
}

void printWrappedUpsideDown(String text) {
  String lines[160];
  int lineCount = 0;

  text.replace("\r", "");

  while (text.length() > 0 && lineCount < 160) {
    int nl = text.indexOf('\n');
    String oneLine = (nl == -1) ? text : text.substring(0, nl);
    text = (nl == -1) ? "" : text.substring(nl + 1);

    if (oneLine.length() == 0) {
      lines[lineCount++] = "";
      continue;
    }

    while (oneLine.length() > 0 && lineCount < 160) {
      int len = min(MAX_CHARS_PER_LINE, (int)oneLine.length());
      lines[lineCount++] = oneLine.substring(0, len);
      oneLine = oneLine.substring(len);
    }
  }

  for (int i = lineCount - 1; i >= 0; i--) {
    printLineSafe(lines[i]);
  }
}

// ============================================================
// Time
// ============================================================
String getFormattedDateTime() {
  timeClient.update();

  unsigned long epochTime = timeClient.getEpochTime();
  time_t rawTime = epochTime;
  struct tm* t = localtime(&rawTime);

  const char* days[]   = {"Sun","Mon","Tue","Wed","Thu","Fri","Sat"};
  const char* months[] = {"Jan","Feb","Mar","Apr","May","Jun",
                          "Jul","Aug","Sep","Oct","Nov","Dec"};

  String out = String(days[t->tm_wday]) + ", ";
  out += String(t->tm_mday < 10 ? "0" : "") + String(t->tm_mday) + " ";
  out += String(months[t->tm_mon]) + " ";
  out += String(t->tm_year + 1900);
  return out;
}
