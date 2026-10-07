# ESP32-CAM ARDUINO IDE SETUP — WIRING & CONFIGURATION

```text
                    ESP32-CAM SETUP
                           │
             ┌─────────────┴─────────────┐
                                         │
                                         ▼
                                  WIRING SETUP
                                         │
                                         ▼
                                   ARDUINO IDE
                                         │
                                         ▼
                              BOARD CONFIGURATION
```

# WIRING SETUP

```text
        ARDUINO                    ESP32-CAM
           │                          │
           ▼                          ▼
    ┌─────────────┐            ┌─────────────┐
    │     TX      │───────────▶│     U0T     │
    │     RX      │───────────▶│     U0R     │
    │     GND     │───────────▶│     GND     │
    │     5V      │───────────▶│     GND     │
    │ RES -> GND  │					│             │
    │     	       │───────────▶│GND -> I0O (upload)│
    └─────────────┘            └─────────────┘
```

| Arduino | ESP32-Cam |
|---------|-----------|
| TX      | U0T       |
| RX      | U0R       |
| GND     | GND       |
| 5V      | GND       |
| RES→ GND|
|         | GND → I0O (during upload) |

# ADD ESP32 BOARD SUPPORT

## Step 1

Open: **File → Preferences**

Find: **Additional boards manager URLs**

Add:

```text
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

## Step 2

Then: **Tools → Board → Boards Manager**

Search: `esp32`

Install: **esp32 by Espressif Systems**

# ARDUINO IDE SETUP

Configure the following settings in **Tools** menu:

| Setting | Value |
|---------|-------|
| Board | "ESP32 Wrover Module" |
| Port | "..." |
| Core Debug level | "Debug" |
| Erase All Flash Before Sketch Upload | "Disabled" |
| Flash Frequency | "80MHz" |
| Flash Mode | "QIO" |
| Partition Scheme | "Minimal SPIFFS (1.9MB APP with OTA/128KB SPIFFS)" |
| Upload Speed | "115200" |
| Programmer | "Esptool" |