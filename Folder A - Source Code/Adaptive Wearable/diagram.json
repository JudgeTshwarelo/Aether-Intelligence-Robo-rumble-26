{
  "version": 1,
  "author": "Sarah Suprise",
  "editor": "wokwi",
  "parts": [
    { "type": "wokwi-arduino-nano", "id": "nano", "top": 0, "left": 0, "attrs": {} },
    {
      "type": "wokwi-led",
      "id": "led1",
      "top": -166.8,
      "left": 71,
      "attrs": { "color": "limegreen" }
    },
    {
      "type": "board-ssd1306",
      "id": "oled1",
      "top": 3.14,
      "left": 182.63,
      "attrs": { "i2cAddress": "0x3c" }
    },
    {
      "type": "wokwi-led",
      "id": "led2",
      "top": -166.8,
      "left": 42.2,
      "attrs": { "color": "yellow" }
    },
    {
      "type": "wokwi-led",
      "id": "led3",
      "top": -166.8,
      "left": 13.4,
      "attrs": { "color": "red" }
    },
    {
      "type": "wokwi-resistor",
      "id": "r1",
      "top": -81.6,
      "left": 9.05,
      "rotate": 90,
      "attrs": { "value": "220" }
    },
    {
      "type": "wokwi-resistor",
      "id": "r2",
      "top": -81.6,
      "left": 37.85,
      "rotate": 90,
      "attrs": { "value": "220" }
    },
    {
      "type": "wokwi-resistor",
      "id": "r3",
      "top": -81.6,
      "left": 66.65,
      "rotate": 90,
      "attrs": { "value": "220" }
    },
    {
      "type": "wokwi-pushbutton",
      "id": "btn1",
      "top": -89.8,
      "left": 144,
      "attrs": { "color": "red", "xray": "1" }
    },
    {
      "type": "wokwi-buzzer",
      "id": "bz1",
      "top": -208.8,
      "left": 107.4,
      "attrs": { "volume": "0.1" }
    },
    { "type": "wokwi-gas-sensor", "id": "gas1", "top": 2.7, "left": -194.6, "attrs": {} },
    {
      "type": "wokwi-dht22",
      "id": "dht1",
      "top": -153.3,
      "left": -63,
      "attrs": { "temperature": "61.7", "humidity": "4" }
    }
  ],
  "connections": [
    [ "oled1:VCC", "nano:5V", "red", [ "v-48", "h96.15", "v163.2", "h-201.1" ] ],
    [ "r1:1", "led3:A", "red", [ "h0", "v-9.6" ] ],
    [ "led3:C", "led2:C", "black", [ "v9.6", "h28.8" ] ],
    [ "r2:2", "nano:9", "gold", [ "h-19.2", "v51.6" ] ],
    [ "led1:C", "led2:C", "black", [ "v9.6", "h-28.8" ] ],
    [ "r1:2", "nano:10", "red", [ "h0", "v18" ] ],
    [ "led2:A", "r2:1", "gold", [ "v19.2" ] ],
    [ "nano:8", "r3:2", "green", [ "h-0.5", "v-43.2", "h38.4" ] ],
    [ "r3:1", "led1:A", "green", [ "h0" ] ],
    [ "nano:GND.1", "oled1:GND", "black", [ "v14.4", "h28.3", "v-86.4", "h48" ] ],
    [ "oled1:SDA", "nano:A4", "green", [ "v-38.4", "h67.27", "v134.4", "h-229.9" ] ],
    [ "oled1:SCL", "nano:A5", "green", [ "v-28.8", "h67.5", "v115.2", "h-210.7" ] ],
    [ "led1:C", "bz1:1", "black", [ "v9.6", "h58" ] ],
    [ "nano:6", "bz1:2", "red", [ "v-14.4", "h28.3", "v-96", "h38.8" ] ],
    [ "btn1:1.l", "nano:2", "red", [ "h-19.2", "v57.6", "h-9.1" ] ],
    [ "bz1:1", "nano:GND.2", "black", [ "v105.6", "h-9.1" ] ],
    [ "btn1:2.r", "nano:GND.2", "black", [ "h9.8", "v38.6", "h-95.5" ] ],
    [ "gas1:VCC", "nano:5V", "red", [ "v75.9", "h182.9" ] ],
    [ "gas1:GND", "nano:GND.1", "black", [ "h9.6", "v47.2", "h144", "h48.5" ] ],
    [ "gas1:AOUT", "nano:A0", "green", [ "h19.2", "v57.6", "h86.9" ] ],
    [ "dht1:GND", "nano:GND.2", "black", [ "v9.6", "h115.2", "h29.3" ] ],
    [ "dht1:VCC", "nano:5V", "red", [ "v153.6", "h173.3" ] ],
    [ "dht1:SDA", "nano:7", "green", [ "v19.2", "h106.2" ] ]
  ],
  "dependencies": {}
}