# AETHER INTELLIGENCE — HOW TO RUN THE  PROTOTYPE

                    AETHER INTELLIGENCE
                           │
             ┌─────────────┴─────────────┐
             │                           
             ▼                           
      3D DIGITAL TWIN              
             │                           
             ▼                           
       Python/FastAPI              
             │                           
             ▼                           
      Browser / 3D UI              

# PART 1 — RUN THE 3D DIGITAL TWIN

The Digital Twin is a Python FastAPI backend that also serves the frontend.
The repository currently contains:

```text
3D Digital Twin/
│
├── backend/
│   ├── main.py
│   ├── engine/
│   │   ├── city_generator.py
│   │   ├── pathfinding.py
│   │   └── simulation.py
│   ├── models/
│   │   └── schemas.py
│   ├── services/
│   ├── websockets/
│   └── tests/
│
├── frontend/
│   ├── index.html
│   ├── css/
│   │   └── styles.css
│   └── js/
│       └── main.js
│
└── requirements.txt
```

## Step 1 — Install Python 3.11 or 3.12

## Step 2 — Clone the repository

Open PowerShell:
```powershell
cd "C:\Users\.....\PycharmProjects" 
```

Then:
```powershell
git clone https://github.com/JudgeTshwarelo/Aether-Intelligence-Robo-rumble-26.git
```

Enter the repository:
```powershell
cd "Aether-Intelligence-Robo-rumble-26"
```

# Step 3 — Enter the Digital Twin

```powershell
cd "Folder A - Source Code\3D Digital Twin"
```

Your terminal should now be approximately:
```text
Aether-Intelligence-Robo-rumble-26
└── Folder A - Source Code
    └── 3D Digital Twin
```

# Step 4 — Create a virtual environment

```powershell
python -m venv .venv
```

Activate it:
```powershell
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks activation, use:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

then:
```powershell
.\.venv\Scripts\Activate.ps1
```

You should now see:
```text
(.venv) PS C:\...
```

# Step 5 — Install the Digital Twin dependencies

Run:
```powershell
python -m pip install --upgrade pip
```

Then:
```powershell
pip install -r requirements.txt
```

# Step 6 — Start the Digital Twin backend

```text
Folder A - Source Code\3D Digital Twin
```

Run:
```powershell
uvicorn backend.main:app --reload
```

You should see something similar to:
```text
INFO:     Uvicorn running on http://127.0.0.1:8000
INFO:     Application startup complete.
```

# Step 7 — Open the Digital Twin

Open:
[http://127.0.0.1:8000](http://127.0.0.1:8000)

or:

[http://localhost:8000](http://localhost:8000)

You should get the AETHER/SKYNET Digital Twin interface.

# DIGITAL TWIN — COMPLETE RUN SEQUENCE

For your demonstration, the actual sequence is simply:
```text
1. Open PowerShell
        │
        ▼
2. Clone repository
        │
        ▼
3. cd "Folder A - Source Code\3D Digital Twin"
        │
        ▼
4. Create virtual environment
        │
        ▼
5. Activate .venv
        │
        ▼
6. pip install -r requirements.txt
        │
        ▼
7. uvicorn backend.main:app --reload
        │
        ▼
8. Open localhost:8000
        │
        ▼
9. DIGITAL TWIN RUNNING
```

# Example if the files are on you local machine

```text
Windows PowerShell
Copyright (C) Microsoft Corporation. All rights reserved.

PS C:\Users\.....\PycharmProjects\PythonProject> cd "C:\Users\.....\PycharmProjects\PythonProject\Digital Twin Python Original\digital twin python"
PS C:\Users\.....\PycharmProjects\PythonProject\Digital Twin Python Original\digital twin python> uvicorn backend.main:app --reload
INFO:     Will watch for changes in these directories: ['C:\\Users\\......\\PycharmProjects\\PythonProject\\Digital Twin Python Original\\digital twin python']
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
INFO:     Started reloader process [16380] using WatchFiles
INFO:     Started server process [6728]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     127.0.0.1:57304 - "GET / HTTP/1.1" 200 OK
INFO:     127.0.0.1:57859 - "GET /static/js/main.js HTTP/1.1" 304 Not Modified
INFO:     127.0.0.1:57304 - "GET /static/css/styles.css HTTP/1.1" 304 Not Modified
INFO:     127.0.0.1:57304 - "GET /api/city HTTP/1.1" 200 OK
INFO:     127.0.0.1:57859 - "GET /favicon.ico HTTP/1.1" 200 OK                                         
INFO:     127.0.0.1:57304 - "GET /api/vehicles HTTP/1.1" 200 OK
INFO:     127.0.0.1:59250 - "WebSocket /ws" [accepted]
INFO:     connection open
INFO:     127.0.0.1:57304 - "POST /api/simulate HTTP/1.1" 200 OK                                       
```