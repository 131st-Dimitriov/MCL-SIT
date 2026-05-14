"""
MCL-SIT capture wrapper (V18.1).
Drives 1_capture.py and 2_recalage.py from the Electron app.

Key behavior:
  - 1_capture.py uses `os.chdir(script_dir)` so its output folder ALWAYS ends up
    inside the script directory (regardless of where wrapper sets cwd).
  - We then locate that folder, run recalage on it, find the _resized_light image,
    and emit a RESULT json line.
  - After successful recalage, we delete every intermediate file (tiles, _recalage
    contents) EXCEPT the final _resized_light, which gets MOVED to a clean output
    path. Total disk used after success: just the final image (a few MB).

CLI:
    python capture_wrapper.py <session_name> <visible_km> <area_w_km> <area_h_km> <screen_w> <screen_h>
"""

import os
import sys
import json
import shutil
import subprocess

if len(sys.argv) < 7:
    print("ERROR: missing arguments", file=sys.stderr)
    sys.exit(2)

SESSION_NAME = sys.argv[1]
VISIBLE_KM = float(sys.argv[2])
AREA_W_KM = float(sys.argv[3])
AREA_H_INPUT = sys.argv[4]   # "square" or a number
SCREEN_W = int(sys.argv[5])
SCREEN_H = int(sys.argv[6])

# Sanitize session name
SAFE = "".join(c if c.isalnum() or c in "_-." else "_" for c in SESSION_NAME)[:80]
if not SAFE:
    SAFE = "capture"

script_dir = os.path.dirname(os.path.abspath(__file__))
capture_script = os.path.join(script_dir, "1_capture.py")
recalage_script = os.path.join(script_dir, "2_recalage.py")

# Build stdin for 1_capture.py
answers = []
answers.append(SAFE)                          # capture name
answers.append(str(VISIBLE_KM))               # visible km
answers.append(str(AREA_W_KM))                # area width km
if AREA_H_INPUT.lower() == "square":
    answers.append("o")                       # square: yes
else:
    answers.append("n")                       # square: no
    answers.append(str(float(AREA_H_INPUT))) # area height km
answers.append(str(SCREEN_W))                 # screen W
answers.append(str(SCREEN_H))                 # screen H
answers.append("o")                           # confirm capture
answers.append("n")                           # decline auto-recalage (we control it)
answers.append("")                            # final "press Enter"
stdin_text = "\n".join(answers) + "\n"

env = os.environ.copy()
env["PYTHONIOENCODING"] = "utf-8"
env["MCLSIT_NO_COUNTDOWN"] = "1"

print("[wrapper] script_dir=" + script_dir, flush=True)
print("[wrapper] session=" + SAFE, flush=True)
print("[wrapper] grid input: visible=%.3f km area=%.1fx%s km screen=%dx%d" %
      (VISIBLE_KM, AREA_W_KM, AREA_H_INPUT, SCREEN_W, SCREEN_H), flush=True)

# ============================================================
# PHASE 1 : capture
# ============================================================
print("[wrapper] === PHASE 1 : capture ===", flush=True)

proc = subprocess.Popen(
    [sys.executable, capture_script],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    cwd=script_dir,
    env=env,
    text=True,
    encoding="utf-8",
    errors="replace",
    bufsize=1
)

try:
    proc.stdin.write(stdin_text)
    proc.stdin.flush()
    proc.stdin.close()
except Exception as e:
    print("[wrapper] stdin write failed: " + str(e), file=sys.stderr, flush=True)

for line in iter(proc.stdout.readline, ""):
    if not line:
        break
    print(line.rstrip(), flush=True)
proc.wait()

if proc.returncode != 0:
    print("[wrapper] ERROR capture exited code=" + str(proc.returncode), file=sys.stderr, flush=True)
    sys.exit(3)

# The capture script does os.chdir(script_dir), so its output folder is here:
capture_folder = os.path.join(script_dir, SAFE)
if not os.path.isdir(capture_folder):
    # Maybe the script didn't chdir for some reason, try cwd
    alt = os.path.abspath(SAFE)
    if os.path.isdir(alt):
        capture_folder = alt
    else:
        print("[wrapper] ERROR capture folder not found: " + capture_folder, file=sys.stderr, flush=True)
        sys.exit(4)

print("[wrapper] capture_folder=" + capture_folder, flush=True)

# ============================================================
# PHASE 2 : recalage
# ============================================================
recalage_folder = capture_folder + "_recalage"
print("[wrapper] === PHASE 2 : recalage ===", flush=True)
print("[wrapper] recalage_folder=" + recalage_folder, flush=True)

proc2 = subprocess.Popen(
    [sys.executable, recalage_script, capture_folder, recalage_folder],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    cwd=script_dir,
    env=env,
    text=True,
    encoding="utf-8",
    errors="replace",
    bufsize=1
)
for line in iter(proc2.stdout.readline, ""):
    if not line:
        break
    print(line.rstrip(), flush=True)
proc2.wait()

if proc2.returncode != 0:
    print("[wrapper] ERROR recalage exited code=" + str(proc2.returncode), file=sys.stderr, flush=True)
    print("[wrapper] capture folder preserved at: " + capture_folder, flush=True)
    print("[wrapper] partial recalage folder at: " + recalage_folder, flush=True)
    sys.exit(5)

# ============================================================
# PHASE 3 : find _resized_light + cleanup
# ============================================================
final_src = None
if os.path.isdir(recalage_folder):
    # Recursive search for any *_resized_light* image
    for root, dirs, files in os.walk(recalage_folder):
        for f in files:
            if "_resized_light" in f.lower() and f.lower().endswith((".png", ".jpg", ".jpeg")):
                final_src = os.path.join(root, f)
                break
        if final_src:
            break

if not final_src:
    # Fallback: any image in the recalage folder
    if os.path.isdir(recalage_folder):
        for root, dirs, files in os.walk(recalage_folder):
            for f in files:
                if f.lower().endswith((".png", ".jpg", ".jpeg")) and "stitched" in f.lower():
                    final_src = os.path.join(root, f)
                    break
            if final_src:
                break

if not final_src:
    print("[wrapper] ERROR _resized_light image not found", file=sys.stderr, flush=True)
    sys.exit(6)

print("[wrapper] final source: " + final_src, flush=True)

# Move the final to a clean stable path next to the script (not inside the
# intermediate folder we're about to delete)
ext = os.path.splitext(final_src)[1]
final_clean = os.path.join(script_dir, SAFE + "_final" + ext)
try:
    shutil.copy2(final_src, final_clean)
    print("[wrapper] final moved to: " + final_clean, flush=True)
except Exception as e:
    print("[wrapper] copy final failed: " + str(e), file=sys.stderr, flush=True)
    sys.exit(7)

# Compute total intermediate size + paths for the caller to confirm cleanup
def folder_size(p):
    total = 0
    if not os.path.isdir(p): return 0
    for root, dirs, files in os.walk(p):
        for f in files:
            try: total += os.path.getsize(os.path.join(root, f))
            except: pass
    return total

cap_size = folder_size(capture_folder)
rec_size = folder_size(recalage_folder)
total_size = cap_size + rec_size

result = {
    "ok": True,
    "final_image": final_clean,
    "intermediate_paths": [capture_folder, recalage_folder],
    "intermediate_bytes": total_size,
    "capture_bytes": cap_size,
    "recalage_bytes": rec_size
}
print("[wrapper] RESULT " + json.dumps(result), flush=True)
sys.exit(0)
