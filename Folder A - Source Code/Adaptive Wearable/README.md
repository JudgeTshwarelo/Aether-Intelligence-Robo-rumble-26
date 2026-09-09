# AETHER INTELLIGENCE — HOW TO RUN THE COMPLETE PROTOTYPE

```text
                    AETHER INTELLIGENCE
                           │
             ┌─────────────┴─────────────┐
                                         │
                                         ▼
                                 ADAPTIVE WATCH
                                         │
                                         ▼
                                   Arduino/Wokwi
                                         │
                                         ▼
                                Sensors + OLED
```

# RUN THE WATCH IN WOKWI

## Step 1

Open: https://wokwi.com/projects/473886817434120193

You should see the simulated circuit

# WHAT THE ADAPTIVE WEARABLE SHOULD LOOK LIKE

The intended architecture is:
```text
                    ADAPTIVE WATCH
                          │
                          ▼
                   ┌─────────────┐
                   │ Arduino Nano│
                   └──────┬──────┘
                          │
          ┌───────────────┼────────────────┐
          │               │                │
          ▼               ▼                ▼
      DHT22           GAS SENSOR       PUSH BUTTON
   Temperature/       Gas level        User input
    Humidity
          │               │                │
          └───────────────┼────────────────┘
                          │
                          ▼
                  SENSOR PROCESSING
                          │
                          ▼
                    DECISION LOGIC
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
          GREEN        YELLOW         RED
            LED           LED          LED
             │            │             │
             └────────────┼─────────────┘
                          │
                          ▼
                       BUZZER
                          │
                          ▼
                    OLED DISPLAY
```

Run the Simulation - Click the "Gas Sensor" and set it up to 0.1ppm

You should see a Serial Monitor

Click the "DHT22" and play around with the "Temperature" which partial act as our heart monitor for simulation