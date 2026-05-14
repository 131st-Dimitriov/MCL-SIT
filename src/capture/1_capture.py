"""
DCS / Mission Editor Map Tile Capture

Requirements:
1) Drag map with RIGHT mouse button (click-hold + drag)
2) Screen resolution and grid size are asked at launch
3) Capture region is computed proportionally to the 4K reference (3500x1800 for 3840x2160)

Notes:
- Run in true fullscreen ideally, and Windows scaling at 100% if possible.
- Keep zoom fixed during capture.
- Place the map at the NORTH-WEST corner of the area you want to capture before starting.
"""

import os
import sys
import time
import json
import math
import subprocess
from datetime import datetime

# DPI awareness (Windows)
try:
    import ctypes
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # Per-monitor DPI aware
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

# Activer les couleurs ANSI dans le terminal Windows
try:
    kernel32 = ctypes.windll.kernel32
    kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
except Exception:
    pass

import pyautogui


# =========================
# ARRET D'URGENCE : 3x ECHAP en < 2 secondes
# =========================
_esc_press_times = []
ABORT_REQUESTED = False

try:
    _user32 = ctypes.windll.user32
    _VK_ESCAPE = 0x1B

    def check_emergency_stop():
        """A appeler regulierement. Si 3 ECHAP detectes en < 2s, leve une exception."""
        global ABORT_REQUESTED, _esc_press_times
        # bit 0x8000 = touche actuellement enfoncee
        # bit 0x0001 = pressee depuis dernier appel (clear)
        state = _user32.GetAsyncKeyState(_VK_ESCAPE)
        if state & 0x0001:
            now = time.time()
            _esc_press_times.append(now)
            # Garder seulement les 3 derniers appuis dans la fenetre de 2s
            _esc_press_times = [t for t in _esc_press_times if now - t < 2.0]
            print(f"   [ECHAP {len(_esc_press_times)}/3]")
            if len(_esc_press_times) >= 3:
                ABORT_REQUESTED = True
                raise KeyboardInterrupt("Arret d'urgence : 3x ECHAP")
except Exception:
    def check_emergency_stop():
        pass


# =========================
# CONFIG
# =========================
TILES_X = None  # sera demandé au lancement
TILES_Y = None  # sera demandé au lancement

SCREEN_W = None  # sera demandé au lancement
SCREEN_H = None  # sera demandé au lancement

CAP_W = None  # calculé proportionnellement
CAP_H = None  # calculé proportionnellement

# Proportions de base (référence 4K)
_BASE_SCREEN_W = 3840
_BASE_SCREEN_H = 2160
_BASE_CAP_W = 3500
_BASE_CAP_H = 1800

# Overlap automatique (4% de la taille de capture, calcule apres resolution)
# Indispensable pour que le NCC ait du contenu partage entre tuiles
OVERLAP_X = 0
OVERLAP_Y = 0
_OVERLAP_RATIO = 0.04

# Keep drag points inside the capture region to avoid grabbing UI borders
EDGE_MARGIN = 20

# Drag in DCS editor: RIGHT mouse button
DRAG_BUTTON = "right"
DRAG_DURATION = 0.8

DELAY_BEFORE_SCREENSHOT = 0.5
DELAY_AFTER_DRAG = 0.8

OUTPUT_DIR = "dcs_map_tiles"

# --- Anti-popup: alternate Y for horizontal drags ---
HORIZ_Y_SWING = 100
_horiz_flip = 1  # internal: +1, -1, +1, ...


def create_output_dir(capture_name):
    folder = capture_name
    os.makedirs(folder, exist_ok=True)
    return folder


def compute_capture_region():
    # Centered crop
    x = (SCREEN_W - CAP_W) // 2
    y = (SCREEN_H - CAP_H) // 2
    return (x, y, CAP_W, CAP_H)


def region_edges(region):
    x, y, w, h = region
    left = x + EDGE_MARGIN
    right = x + w - EDGE_MARGIN
    top = y + EDGE_MARGIN
    bottom = y + h - EDGE_MARGIN
    cx = x + w // 2
    cy = y + h // 2
    return left, right, top, bottom, cx, cy


def next_horiz_y(region):
    """
    Alternate the drag Y position for horizontal moves:
    cy+100, cy-100, cy+100...
    and clamp inside the capture region.
    """
    global _horiz_flip
    left, right, top, bottom, cx, cy = region_edges(region)

    yy = cy + (_horiz_flip * HORIZ_Y_SWING)
    _horiz_flip *= -1

    yy = max(top, min(bottom, yy))
    return yy


def write_metadata(folder, region):
    meta = {
        "screen": {"w": SCREEN_W, "h": SCREEN_H},
        "capture_region": {"x": region[0], "y": region[1], "w": region[2], "h": region[3]},
        "grid": {"tiles_x": TILES_X, "tiles_y": TILES_Y},
        "overlap_px": {"x": OVERLAP_X, "y": OVERLAP_Y},
        "drag_button": DRAG_BUTTON,
        "note": f"Mission Editor capture, centered crop {CAP_W}x{CAP_H} on {SCREEN_W}x{SCREEN_H}",
        "anti_popup": {"horiz_y_swing": HORIZ_Y_SWING, "pattern": "+100/-100 alternating"},
    }
    with open(os.path.join(folder, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)


def capture_tile(folder, region, row, col):
    path = os.path.join(folder, f"tile_{row:03d}_{col:03d}.png")

    # petite pause avant capture
    time.sleep(DELAY_BEFORE_SCREENSHOT)

    x, y, w, h = region
    bbox = (x, y, x + w, y + h)

    last_err = None

    for attempt in range(1, 9):  # 8 tentatives
        try:
            # voie 1: pyautogui
            img = pyautogui.screenshot(region=region)
            if img.size != (w, h):
                raise RuntimeError(f"Bad capture size: got {img.size}, expected {(w, h)}")
            img.save(path)
            return path

        except Exception as e:
            last_err = e
            # voie 2: fallback ImageGrab direct
            try:
                from PIL import ImageGrab
                img = ImageGrab.grab(bbox=bbox, all_screens=False)
                if img.size != (w, h):
                    raise RuntimeError(f"Bad capture size (fallback): got {img.size}, expected {(w, h)}")
                img.save(path)
                return path
            except Exception as e2:
                last_err = e2

            # backoff progressif
            time.sleep(0.15 * attempt)

    # si on arrive ici: trop d'échecs
    raise RuntimeError(f"Screen grab failed after retries at tile ({row},{col}): {last_err}")


def drag_from_to(x1, y1, x2, y2):
    pyautogui.moveTo(x1, y1)
    pyautogui.mouseDown(button=DRAG_BUTTON)
    pyautogui.moveTo(x2, y2, duration=DRAG_DURATION)
    pyautogui.mouseUp(button=DRAG_BUTTON)
    time.sleep(DELAY_AFTER_DRAG)


# ===== Intended map moves (no overlap) =====
# To see new area to the EAST, you drag the map WEST.
# To see new area to the SOUTH, you drag the map NORTH.

def move_east(region):
    left, right, top, bottom, cx, cy = region_edges(region)
    yy = next_horiz_y(region)
    step = region[2] - OVERLAP_X
    drag_from_to(right, yy, max(left, right - step), yy)


def move_west(region):
    left, right, top, bottom, cx, cy = region_edges(region)
    yy = next_horiz_y(region)
    step = region[2] - OVERLAP_X
    drag_from_to(left, yy, min(right, left + step), yy)


def move_south(region):
    left, right, top, bottom, cx, cy = region_edges(region)
    step = region[3] - OVERLAP_Y
    drag_from_to(cx, bottom, cx, max(top, bottom - step))


def main():
    global TILES_X, TILES_Y, SCREEN_W, SCREEN_H, CAP_W, CAP_H

    print("=" * 72)
    print("DCS Mission Editor Tile Capture - RIGHT-DRAG")
    print("=" * 72)

    # --- Nom de la capture ---
    while True:
        capture_name = input("\n📛 Nom de la capture (ex: caire, golfe_suez) : ").strip()
        if capture_name:
            # Nettoyer les caracteres problematiques
            invalid_chars = '<>:"/\\|?*'
            if any(ch in capture_name for ch in invalid_chars):
                print(f"   ⚠️ Caracteres interdits : {invalid_chars}")
                continue
            break
        print("   ⚠️ Le nom ne peut pas etre vide.")

    # --- Calcul de la grille à partir des dimensions en km ---

    while True:
        try:
            G = float(input("\n📏 Largeur visible de la fenêtre éditeur (km, ex: 5.653) : "))
            if G <= 0:
                raise ValueError
            break
        except (ValueError, EOFError):
            print("   ⚠️ Entre un nombre > 0.")

    while True:
        try:
            L = float(input("📏 Largeur de la zone à cartographier (km, ex: 20) : "))
            if L <= 0:
                raise ValueError
            break
        except (ValueError, EOFError):
            print("   ⚠️ Entre un nombre > 0.")

    TILES_X = math.ceil(L / (0.9 * G))
    print(f"   ➜ TILES_X = ⌈{L} / (0.9 × {G})⌉ = {TILES_X}")

    while True:
        try:
            carre = input("\n🗺️  Zone carrée ? (o/n) : ").strip().lower()
            if carre in ("o", "oui", "y", "yes"):
                TILES_Y = 2 * TILES_X
                print(f"   ➜ TILES_Y = 2 × TILES_X = {TILES_Y}")
                break
            elif carre in ("n", "non", "no"):
                while True:
                    try:
                        H = float(input("📏 Hauteur de la zone à cartographier (km, ex: 20) : "))
                        if H <= 0:
                            raise ValueError
                        break
                    except (ValueError, EOFError):
                        print("   ⚠️ Entre un nombre > 0.")

                TILES_Y = math.ceil((2 * H) / (0.9 * G))
                print(f"   ➜ TILES_Y = ⌈(2 × {H}) / (0.9 × {G})⌉ = {TILES_Y}")
                break
            else:
                print("   ⚠️ Réponds o ou n.")
        except EOFError:
            print("   ⚠️ Réponds o ou n.")

    print(f"\n🔢 Grille finale : {TILES_X} × {TILES_Y} = {TILES_X * TILES_Y} tuiles")

    # --- Demander la résolution d'écran ---
    while True:
        try:
            SCREEN_W = int(input("\n🖥️  Résolution écran X (largeur, ex: 3840) : "))
            if SCREEN_W < 640:
                raise ValueError
            break
        except (ValueError, EOFError):
            print("   ⚠️ Entre un entier ≥ 640.")

    while True:
        try:
            SCREEN_H = int(input("🖥️  Résolution écran Y (hauteur, ex: 2160) : "))
            if SCREEN_H < 480:
                raise ValueError
            break
        except (ValueError, EOFError):
            print("   ⚠️ Entre un entier ≥ 480.")

    # --- Calcul proportionnel de la zone de capture (même ratio qu'en 4K) ---
    CAP_W = int(SCREEN_W * _BASE_CAP_W / _BASE_SCREEN_W)
    CAP_H = int(SCREEN_H * _BASE_CAP_H / _BASE_SCREEN_H)
    # Arrondir aux pixels pairs pour centrage propre
    CAP_W -= CAP_W % 2
    CAP_H -= CAP_H % 2

    print(f"\n📐 Zone de capture calculée : {CAP_W}x{CAP_H} "
          f"(ratio 4K : {_BASE_CAP_W}/{_BASE_SCREEN_W} × {_BASE_CAP_H}/{_BASE_SCREEN_H})")

    sw, sh = pyautogui.size()
    print(f"pyautogui.size(): {sw}x{sh}")
    if (sw, sh) != (SCREEN_W, SCREEN_H):
        print(f"⚠️ Résolution détectée ({sw}x{sh}) différente de {SCREEN_W}x{SCREEN_H}.")
        print("   Mets l'appli en plein écran à la bonne résolution pour des résultats fiables.\n")

    region = compute_capture_region()
    print(f"CAPTURE_REGION: x={region[0]} y={region[1]} w={region[2]} h={region[3]}")
    print(f"GRID: {TILES_X} x {TILES_Y} = {TILES_X*TILES_Y} captures")
    print(f"DRAG: button={DRAG_BUTTON}, duration={DRAG_DURATION}s")
    print(f"OVERLAP: {OVERLAP_X}px / {OVERLAP_Y}px")
    print(f"ANTI-POPUP: horiz drag y swing = +/-{HORIZ_Y_SWING}px\n")

    # --- Durée estimée ---
    total_tiles = TILES_X * TILES_Y
    nb_horiz_drags = TILES_Y * (TILES_X - 1)
    nb_vert_drags = TILES_Y - 1
    time_screenshots = total_tiles * (DELAY_BEFORE_SCREENSHOT + 0.55)  # +0.55s capture reelle
    time_drags = (nb_horiz_drags + nb_vert_drags) * (DRAG_DURATION + DELAY_AFTER_DRAG + 0.1)  # +0.1s moveTo
    est_seconds = time_screenshots + time_drags
    est_min = int(est_seconds // 60)
    est_sec = int(est_seconds % 60)

    RED = "\033[91m"
    RESET = "\033[0m"
    print(f"{RED}⏱️  Durée estimée de la capture : {est_min} min {est_sec:02d} s  ({total_tiles} tuiles){RESET}\n")

    print("INSTRUCTIONS:")
    print("  1) Ouvre l'éditeur de mission, vue carte (celle que tu veux capturer)")
    print("  2) Place-toi au coin NORD-OUEST de la zone à capturer")
    print("  3) Ne change plus le ZOOM pendant la capture")
    print("  4) Ne touche plus à la souris/clavier pendant la capture")
    print(f"  5) ARRET D'URGENCE : appuie 3x sur ECHAP en moins de 2 secondes\n")

    # --- Confirmation finale ---
    answer = input(f"📋 La capture fera {total_tiles} tuiles et durera ~{est_min} min {est_sec:02d} s. Continuer ? (o/n) : ").strip().lower()
    if answer not in ("o", "oui", "y", "yes", ""):
        print("⛔ Capture annulée par l'utilisateur.")
        return

    # MCL-SIT: skip the countdown when launched from Electron — the UI
    # has already handled it. Otherwise run the original 10s loop.
    if os.environ.get("MCLSIT_NO_COUNTDOWN") == "1":
        print("\nDépart immédiat (mode MCL-SIT).")
    else:
        print("\nDépart dans 10 secondes...")
        for i in range(10, 0, -1):
            print(f"  {i}...")
            time.sleep(1)

    folder = create_output_dir(capture_name)
    write_metadata(folder, region)
    print(f"\n📁 Output folder: {folder}\n")

    total = TILES_X * TILES_Y
    idx = 0

    for row in range(TILES_Y):
        left_to_right = (row % 2 == 0)
        cols = range(TILES_X) if left_to_right else range(TILES_X - 1, -1, -1)

        for col in cols:
            check_emergency_stop()
            idx += 1
            print(f"[{idx}/{total}] Capturing tile ({row},{col})")
            capture_tile(folder, region, row, col)

            last = (col == (TILES_X - 1) if left_to_right else col == 0)
            if not last:
                check_emergency_stop()
                move_east(region) if left_to_right else move_west(region)

        if row < TILES_Y - 1:
            check_emergency_stop()
            move_south(region)

    print("\n✅ Capture terminée.")
    print(f"📁 Dossier: {folder}")

    # --- Proposer le lancement automatique du recalage ---
    script_dir = os.path.dirname(os.path.abspath(__file__))
    recalage_script = os.path.join(script_dir, "2_recalage.py")

    if os.path.isfile(recalage_script):
        print(f"\n🔧 Script de recalage détecté : {recalage_script}")
        answer = input("   Lancer le recalage automatiquement ? (o/n) : ").strip().lower()
        if answer in ("o", "oui", "y", "yes"):
            out_recalage = folder + "_recalage"
            print(f"\n🚀 Lancement de 2_recalage.py ...")
            print(f"   Entrée : {folder}")
            print(f"   Sortie : {out_recalage}\n")
            subprocess.run([sys.executable, recalage_script, folder, out_recalage])
        else:
            print("   ⏭️ Recalage ignoré. Tu pourras le lancer manuellement :")
            print(f"      py 2_recalage.py \"{folder}\" \"{folder}_recalage\"")
    else:
        print(f"\nℹ️ Pour recaler les tuiles, lance :")
        print(f"   py 2_recalage.py \"{folder}\" \"{folder}_recalage\"")


if __name__ == "__main__":
    # Se placer dans le dossier du script (indispensable en double-clic)
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    pyautogui.FAILSAFE = False
    try:
        main()
    except pyautogui.FailSafeException:
        print("\n⛔ FAILSAFE: souris dans un coin => stop")
    except KeyboardInterrupt:
        print("\n⛔ Interrompu par l'utilisateur")
    except Exception as e:
        print(f"\n❌ ERREUR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        print()
        input("Appuie sur Entrée pour fermer cette fenêtre...")
