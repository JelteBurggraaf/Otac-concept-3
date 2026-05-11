#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_NeoPixel.h>

// ── Pin layout ────────────────────────────────────────────────────────────────
//  Module 1
const int PIN_SWITCH   =  4;   // A3 — lever switch (S:QUIZ / S:VIDEO)
// GPIO 21 = SDA  (shared I2C bus: rotary dial + LCD)
// GPIO 22 = SCL  (shared I2C bus: rotary dial + LCD)
const int PIN_LED_RGBW =  5;   // A6 — SK6812 RGBW LED strip, 18 LEDs

// ── LED strip ─────────────────────────────────────────────────────────────────
#define HW_LED_COUNT 18
Adafruit_NeoPixel strip(HW_LED_COUNT, PIN_LED_RGBW, NEO_GRBW + NEO_KHZ800);

// Physical order of LEDs along the bar (1-based → strip index = value - 1)
const uint8_t PHYSICAL_ORDER[HW_LED_COUNT] = {
  12, 1, 13, 11, 2, 14, 10, 3, 15, 9, 4, 16, 8, 5, 17, 7, 6, 18
};

// Maps software state char ('0'-'6') to SK6812 RGBW color
uint32_t stateToColor(char s) {
  switch (s) {
    case '1': return strip.Color(255, 198, 129,  0);  // on    — amber  #FFC681
    case '2': return strip.Color(255, 250, 190, 30);  // full  — bright #FFFABE
    case '3': return strip.Color( 62, 201, 106,  0);  // done  — green  #3EC96A
    case '4': return strip.Color(  0,  60, 220,  0);  // data  — saturated blue
    case '5': return strip.Color(255, 130,   0,  0);  // quiz  — warm orange
    case '6': return strip.Color(255, 255, 255,150);  // flash — white
    default:  return strip.Color(  0,   0,   0,  0);  // off
  }
}

// Browser sends 20 LED states; scale evenly to 18 hardware positions
void applyLedCommand(const String &payload) {
  if (payload.length() < 20) return;
  strip.clear();
  for (int hw = 0; hw < HW_LED_COUNT; hw++) {
    int sw = (int)round(hw * 19.0f / 17.0f);
    if (sw > 19) sw = 19;
    int stripIdx = PHYSICAL_ORDER[hw] - 1;
    strip.setPixelColor(stripIdx, stateToColor(payload[sw]));
  }
  strip.show();
}

//  Module 2
const int PIN_BTN_LEFT  = 13;  // B3 — bias button left  (B:LEFT)
const int PIN_BTN_RIGHT = 14;  // B4 — bias button right (B:RIGHT)
const int PIN_PUMP      = 16;  // B5 — water pump relay  (OUTPUT, active HIGH)
const int PIN_DISTANCE  = 34;  // B6 — analog distance sensor (D:<value>)

//  Module 3
const int PIN_PUMP_HIGH = 25;  // C3 — pump top sensor    (C:HIGH)
const int PIN_PUMP_LOW  = 26;  // C4 — pump bottom sensor (C:LOW)
// GPIO 21 = LCD SDA  (shared with Module 1)
// GPIO 22 = LCD SCL  (shared with Module 1)
// ─────────────────────────────────────────────────────────────────────────────

// ── Debounced digital input ───────────────────────────────────────────────────
const unsigned long DEBOUNCE_MS = 30;

struct DebouncedInput {
  int pin;
  bool activeLow;
  bool stableOn  = false;
  bool lastRaw   = false;
  uint32_t lastChange = 0;

  DebouncedInput(int p, bool al) : pin(p), activeLow(al) {}

  void beginPullupIfNeeded() {
    pinMode(pin, activeLow ? INPUT_PULLUP : INPUT);
    lastRaw    = digitalRead(pin);
    stableOn   = rawToOn(lastRaw);
    lastChange = millis();
  }
  bool rawToOn(bool raw) const { return activeLow ? (raw == LOW) : (raw == HIGH); }
  bool update() {
    bool raw = digitalRead(pin);
    if (raw != lastRaw) { lastRaw = raw; lastChange = millis(); }
    bool prev = stableOn;
    if (millis() - lastChange >= DEBOUNCE_MS) stableOn = rawToOn(lastRaw);
    return stableOn != prev;
  }
  bool on() const { return stableOn; }
};

DebouncedInput swInput  {PIN_SWITCH,    true};
DebouncedInput btnLeft  {PIN_BTN_LEFT,  true};
DebouncedInput btnRight {PIN_BTN_RIGHT, true};
DebouncedInput pumpHigh {PIN_PUMP_HIGH, true};
DebouncedInput pumpLow  {PIN_PUMP_LOW,  true};

// ── Pump relay ────────────────────────────────────────────────────────────────
unsigned long pumpOffAt = 0;

void setRelay(bool on) {
  digitalWrite(PIN_PUMP, on ? HIGH : LOW);
}

// ── Rotary encoder (direct I2C — supports QwiicTwist and Seesaw) ──────────────
enum class RotaryType { None, QwiicTwist, Seesaw };
RotaryType rotaryType = RotaryType::None;
uint8_t    rotaryAddr = 0;

bool i2cPing(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

void i2cDetectRotary() {
  rotaryType = RotaryType::None;
  rotaryAddr = 0;
  for (uint8_t addr = 8; addr < 120; addr++) {
    if (!i2cPing(addr)) continue;
    if (addr == 0x3F || addr == 0x3E) {
      rotaryType = RotaryType::QwiicTwist; rotaryAddr = addr; return;
    }
    if (addr >= 0x36 && addr <= 0x3D) {
      rotaryType = RotaryType::Seesaw; rotaryAddr = addr; return;
    }
  }
}

// Qwiic Twist: encoderCount at register 0x05 (MSB) + 0x06 (LSB)
bool qwiicReadEncoderCount(int16_t &countOut) {
  Wire.beginTransmission(rotaryAddr);
  Wire.write((uint8_t)0x05);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)rotaryAddr, 2) != 2) return false;
  uint8_t msb = Wire.read();
  uint8_t lsb = Wire.read();
  countOut = (int16_t)((msb << 8) | lsb);
  return true;
}

bool seesawRead(uint8_t moduleBase, uint8_t moduleFunction, uint8_t *buf, size_t n) {
  Wire.beginTransmission(rotaryAddr);
  Wire.write(moduleBase);
  Wire.write(moduleFunction);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)rotaryAddr, (int)n) != (int)n) return false;
  for (size_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

// Seesaw encoder: base 0x11, delta register 0x40 (4 bytes signed MSB first)
bool seesawReadDelta(int32_t &deltaOut) {
  uint8_t b[4];
  if (!seesawRead(0x11, 0x40, b, 4)) return false;
  deltaOut = (int32_t)((uint32_t)b[0] << 24 | (uint32_t)b[1] << 16 |
                       (uint32_t)b[2] <<  8 | (uint32_t)b[3]);
  return true;
}

// ── LCD (auto-detected address) ───────────────────────────────────────────────
LiquidCrystal_I2C *lcd = nullptr;

uint8_t detectLcdAddress(uint8_t addrToSkip) {
  if (0x27 != addrToSkip && i2cPing(0x27)) return 0x27;
  if (0x3F != addrToSkip && i2cPing(0x3F)) return 0x3F;
  for (uint8_t addr = 8; addr < 120; addr++) {
    if (addr == addrToSkip) continue;
    if (i2cPing(addr)) return addr;
  }
  return 0;
}

void lcdShow(const char *line1, const char *line2) {
  if (!lcd) return;
  lcd->clear();
  lcd->setCursor(0, 0); lcd->print(line1);
  lcd->setCursor(0, 1); lcd->print(line2);
}

// ── Distance sensor ───────────────────────────────────────────────────────────
unsigned long lastDistanceMs = 0;
const unsigned long DISTANCE_INTERVAL_MS = 100;

// ── Incoming serial buffer ────────────────────────────────────────────────────
String serialBuf = "";

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);

  // ADC — configure before first analogRead
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_DISTANCE, ADC_11db);

  // LED strip (Module 1)
  strip.begin();
  strip.setBrightness(80);
  strip.clear();
  strip.show();

  // Pump relay (Module 2)
  pinMode(PIN_PUMP, OUTPUT);
  setRelay(false);

  // Debounced inputs
  swInput.beginPullupIfNeeded();
  btnLeft.beginPullupIfNeeded();
  btnRight.beginPullupIfNeeded();
  pumpHigh.beginPullupIfNeeded();
  pumpLow.beginPullupIfNeeded();

  // I2C + rotary detection
  Wire.begin(21, 22);
  Wire.setClock(400000);
  i2cDetectRotary();

  // LCD auto-detect (skip rotary address to avoid false match)
  uint8_t addrToSkip = (rotaryType != RotaryType::None) ? rotaryAddr : 0;
  uint8_t lcdAddr = detectLcdAddress(addrToSkip);
  if (lcdAddr) {
    lcd = new LiquidCrystal_I2C(lcdAddr, 16, 2);
    lcd->init();
    lcd->backlight();
    lcd->clear();
    lcdShow("OLTC gereed", "");
  } else {
    Serial.println("ERR:LCD");
  }

  // Boot status
  if (rotaryType == RotaryType::QwiicTwist) {
    Serial.print("INFO:ROTARY=QwiicTwist@0x");
    Serial.println(rotaryAddr, HEX);
  } else if (rotaryType == RotaryType::Seesaw) {
    Serial.print("INFO:ROTARY=Seesaw@0x");
    Serial.println(rotaryAddr, HEX);
  } else {
    Serial.println("ERR:ROTARY");
  }
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // ── Module 1: Rotary encoder ──────────────────────────────────────────────
  static uint32_t lastRotaryPoll = 0;
  if (now - lastRotaryPoll >= 20) {
    lastRotaryPoll = now;
    if (rotaryType == RotaryType::QwiicTwist) {
      static int16_t prevCount = 0;
      int16_t curCount = 0;
      if (qwiicReadEncoderCount(curCount)) {
        int16_t diff = curCount - prevCount;
        if (diff != 0) { Serial.println("R:" + String(diff)); prevCount = curCount; }
      }
    } else if (rotaryType == RotaryType::Seesaw) {
      int32_t delta = 0;
      if (seesawReadDelta(delta) && delta != 0)
        Serial.println("R:" + String((int)delta));
    }
  }

  // ── Module 1: Lever switch ────────────────────────────────────────────────
  if (swInput.update())
    Serial.println(swInput.on() ? "S:QUIZ" : "S:VIDEO");

  // ── Module 2: Bias buttons ────────────────────────────────────────────────
  if (btnLeft.update()  && btnLeft.on())  Serial.println("B:RIGHT");
  if (btnRight.update() && btnRight.on()) Serial.println("B:LEFT");

  // ── Module 2: Distance sensor (analog) ───────────────────────────────────
  if (now - lastDistanceMs >= DISTANCE_INTERVAL_MS) {
    lastDistanceMs = now;
    int val = analogRead(PIN_DISTANCE);
    Serial.println("D:" + String(val));
  }

  // ── Module 2: Pump relay auto-off ────────────────────────────────────────
  if (pumpOffAt > 0 && now >= pumpOffAt) {
    setRelay(false);
    pumpOffAt = 0;
  }

  // ── Module 3: Pump switches ───────────────────────────────────────────────
  if (pumpHigh.update() && pumpHigh.on()) {
    Serial.println("C:HIGH");
  }
  if (pumpLow.update()  && pumpLow.on())  Serial.println("C:LOW");

  // ── Incoming serial (LCD / LED / PUMP commands from browser) ─────────────
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      serialBuf.trim();

      // LCD:0,text  or  LCD:1,text
      if (serialBuf.startsWith("LCD:")) {
        int comma = serialBuf.indexOf(',', 4);
        if (comma > 4) {
          int row    = serialBuf.substring(4, comma).toInt();
          String txt = serialBuf.substring(comma + 1);
          while ((int)txt.length() < 16) txt += ' ';
          if (lcd) {
            lcd->setCursor(0, row);
            lcd->print(txt.substring(0, 16));
          }
        }
      }

      // LED:<20 states>
      else if (serialBuf.startsWith("LED:")) {
        applyLedCommand(serialBuf.substring(4));
      }

      // PUMP:<ms>
      else if (serialBuf.startsWith("PUMP:")) {
        int duration = serialBuf.substring(5).toInt();
        if (duration > 0 && duration <= 5000) {
          setRelay(true);
          pumpOffAt = millis() + duration;
        }
      }

      serialBuf = "";
    } else {
      if (serialBuf.length() < 256) serialBuf += c;
    }
  }

  delay(5);
}
