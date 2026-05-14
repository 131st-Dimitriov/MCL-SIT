import os
import re
import sys
import math
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
import numpy as np
import cv2

# Activer les couleurs ANSI dans le terminal Windows
try:
    import ctypes
    kernel32 = ctypes.windll.kernel32
    kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
except Exception:
    pass

TILE_RE = re.compile(r"tile_(\d+)_(\d+)\.(png|jpg|jpeg)$", re.IGNORECASE)

# =========================================================
# PARAMETRES - auto-detectes depuis les tuiles
# =========================================================
TILE_W = None  # detecte automatiquement
TILE_H = None  # detecte automatiquement

# Valeurs de reference (4K crop) pour mise a l'echelle
_REF_TILE_W = 3500
_REF_TILE_H = 1800
_REF_SEARCH_X = 200
_REF_SEARCH_Y = 200
_REF_SEARCH_DX_VERT = 30   # petit pour eviter les faux matchs horizontaux sur zones uniformes
_REF_BAND_W = 520
_REF_BAND_H = 360

# Seront recalcules proportionnellement
SEARCH_X = None
SEARCH_Y = None
SEARCH_DX_VERT = None   # recherche dx pendant matching vertical
BAND_W = None
BAND_H = None

# Sous-echantillonnage (accelere)
SUBSAMPLE = 2

# Seuil de confiance NCC : en dessous, on utilise le deplacement nominal
NCC_CONFIDENCE = 0.2

# Correction maximale autorisee par rapport au nominal (en pixels)
MAX_CORRECTION = 100

# Sortie
OUT_TILE_PREFIX = "tile_"


def ensure_dir(p: str) -> None:
    os.makedirs(p, exist_ok=True)


def find_tiles(folder: str):
    """
    Retourne:
      tiles: dict[(r,c)] = filepath
      min_r, min_c, R, C
    """
    tiles = {}
    rows, cols = [], []

    for fn in os.listdir(folder):
        m = TILE_RE.match(fn)
        if not m:
            continue
        r = int(m.group(1))
        c = int(m.group(2))
        tiles[(r, c)] = os.path.join(folder, fn)
        rows.append(r)
        cols.append(c)

    if not tiles:
        raise RuntimeError("Aucune tuile trouvée (attendu: tile_###_###.png)")

    min_r, max_r = min(rows), max(rows)
    min_c, max_c = min(cols), max(cols)
    R = max_r - min_r + 1
    C = max_c - min_c + 1

    # check holes
    missing = []
    for rr in range(min_r, max_r + 1):
        for cc in range(min_c, max_c + 1):
            if (rr, cc) not in tiles:
                missing.append((rr, cc))
    if missing:
        print(f"⚠️ WARNING: {len(missing)} tuiles manquantes dans la grille détectée.")
        print("   Exemples:", missing[:10])

    return tiles, min_r, min_c, R, C


def load_gray(path: str) -> np.ndarray:
    im = Image.open(path).convert("RGB")
    if im.size != (TILE_W, TILE_H):
        raise RuntimeError(
            f"Bad tile size for {os.path.basename(path)}: got {im.size}, expected {(TILE_W, TILE_H)}\n"
            f"   Toutes les tuiles doivent avoir la meme taille."
        )
    arr = np.asarray(im, dtype=np.float32)
    g = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    return g


def detect_tile_size(tiles: dict) -> tuple:
    """Ouvre la premiere tuile trouvee et retourne (largeur, hauteur)."""
    first_path = next(iter(tiles.values()))
    im = Image.open(first_path)
    w, h = im.size
    im.close()
    return w, h


def init_params_from_tile_size(w: int, h: int):
    """Recalcule tous les parametres proportionnellement a la taille reelle des tuiles."""
    global TILE_W, TILE_H, SEARCH_X, SEARCH_Y, SEARCH_DX_VERT, BAND_W, BAND_H

    TILE_W = w
    TILE_H = h

    scale_x = w / _REF_TILE_W
    scale_y = h / _REF_TILE_H

    SEARCH_X = max(20, int(_REF_SEARCH_X * scale_x))
    SEARCH_Y = max(20, int(_REF_SEARCH_Y * scale_y))
    SEARCH_DX_VERT = max(10, int(_REF_SEARCH_DX_VERT * scale_x))
    BAND_W   = max(64, int(_REF_BAND_W * scale_x))
    BAND_H   = max(64, int(_REF_BAND_H * scale_y))


def ncc(a: np.ndarray, b: np.ndarray) -> float:
    a = a.astype(np.float32)
    b = b.astype(np.float32)
    a = a - a.mean()
    b = b - b.mean()
    den = (np.linalg.norm(a) * np.linalg.norm(b))
    if den < 1e-6:
        return -1e9
    return float((a * b).sum() / den)


def best_dx_horizontal(A: np.ndarray, B: np.ndarray):
    """
    B est à droite de A.
    Anti-dérive: dy forcé à 0.
    Cherche uniquement dx ~ TILE_W avec recouvrement > 0.
    Teste 3 positions Y (haut, centre, bas) et garde le meilleur score.
    Raffinement sub-pixel par interpolation parabolique autour du meilleur match.
    """
    y_positions = [
        BAND_H // 2,                    # haut
        TILE_H // 2,                    # centre
        TILE_H - BAND_H // 2,           # bas
    ]

    best_score = -1e9
    best_dx = TILE_W
    best_scores_around = None  # (score_left, score_center, score_right) du best

    for yc in y_positions:
        y0 = max(0, yc - BAND_H // 2)
        y1 = min(TILE_H, y0 + BAND_H)

        A_band = A[y0:y1, TILE_W - BAND_W:TILE_W]
        B_band = B[y0:y1, 0:BAND_W]

        A_band = A_band[::SUBSAMPLE, ::SUBSAMPLE]
        B_band = B_band[::SUBSAMPLE, ::SUBSAMPLE]

        # On stocke tous les scores pour le raffinement parabolique
        scores_for_pos = {}

        for dx in range(TILE_W - SEARCH_X, TILE_W + SEARCH_X + 1):
            overlap = TILE_W - dx
            if overlap <= 0:
                continue
            if overlap > BAND_W:
                continue

            ov = max(16, int(overlap / SUBSAMPLE))
            if ov > A_band.shape[1] or ov > B_band.shape[1]:
                continue

            a_ov = A_band[:, -ov:]
            b_ov = B_band[:, :ov]
            score = ncc(a_ov, b_ov)
            scores_for_pos[dx] = score

            if score > best_score:
                best_score = score
                best_dx = dx
                # Voisins immediats pour le raffinement parabolique
                best_scores_around = (
                    scores_for_pos.get(dx - 1),
                    score,
                    None  # sera rempli juste après si dispo
                )

        # Compléter le voisin de droite après la boucle
        if best_scores_around and best_scores_around[2] is None:
            best_scores_around = (
                best_scores_around[0],
                best_scores_around[1],
                scores_for_pos.get(best_dx + 1)
            )

    # Raffinement parabolique sub-pixel
    if best_scores_around and best_scores_around[0] is not None and best_scores_around[2] is not None:
        sL, sC, sR = best_scores_around
        denom = (sL - 2 * sC + sR)
        if abs(denom) > 1e-9:
            delta = 0.5 * (sL - sR) / denom
            # Clamper le raffinement entre -1 et +1 pixel
            if -1.0 < delta < 1.0:
                return float(best_dx) + delta, best_score

    return float(best_dx), best_score


def best_dxdy_vertical(A: np.ndarray, B: np.ndarray):
    """
    B est sous A.
    Cherche dy ~ TILE_H ET dx dans [-SEARCH_DX_VERT, +SEARCH_DX_VERT].
    Teste 3 positions X (gauche, centre, droite) et garde le meilleur score.
    """
    x_positions = [
        BAND_W // 2,                    # gauche
        TILE_W // 2,                    # centre
        TILE_W - BAND_W // 2,           # droite (correction du bug)
    ]

    best_score = -1e9
    best_dy = TILE_H
    best_dx = 0
    # Pour le raffinement sub-pixel : on garde tous les scores autour du best
    all_scores = {}  # (dx, dy) -> score

    for xc in x_positions:
        x0 = max(0, xc - BAND_W // 2)
        x1 = min(TILE_W, x0 + BAND_W)
        bw_local = x1 - x0

        for dy in range(TILE_H - SEARCH_Y, TILE_H + SEARCH_Y + 1):
            overlap_y = TILE_H - dy
            if overlap_y <= 0 or overlap_y > BAND_H:
                continue

            # Pas de 1 pour SEARCH_DX_VERT (au lieu de SUBSAMPLE) pour meilleure precision
            for dx in range(-SEARCH_DX_VERT, SEARCH_DX_VERT + 1):
                ax0 = max(0, x0 + dx)
                bx0 = max(0, x0 - dx)
                common_w = min(x1 + dx, TILE_W) - ax0
                if common_w < bw_local // 2:
                    continue

                a_patch = A[TILE_H - overlap_y:TILE_H, ax0:ax0 + common_w]
                b_patch = B[0:overlap_y, bx0:bx0 + common_w]

                a_patch = a_patch[::SUBSAMPLE, ::SUBSAMPLE]
                b_patch = b_patch[::SUBSAMPLE, ::SUBSAMPLE]

                if a_patch.shape[0] < 8 or a_patch.shape[1] < 8:
                    continue
                if a_patch.shape != b_patch.shape:
                    continue

                score = ncc(a_patch, b_patch)
                all_scores[(dx, dy)] = score

                if score > best_score:
                    best_score = score
                    best_dy = dy
                    best_dx = dx

    # Raffinement parabolique 2D autour de (best_dx, best_dy)
    refined_dx = float(best_dx)
    refined_dy = float(best_dy)

    # Raffinement sur dy
    sC = best_score
    sU = all_scores.get((best_dx, best_dy - 1))
    sD = all_scores.get((best_dx, best_dy + 1))
    if sU is not None and sD is not None:
        denom = (sU - 2 * sC + sD)
        if abs(denom) > 1e-9:
            delta_y = 0.5 * (sU - sD) / denom
            if -1.0 < delta_y < 1.0:
                refined_dy += delta_y

    # Raffinement sur dx
    sL = all_scores.get((best_dx - 1, best_dy))
    sR = all_scores.get((best_dx + 1, best_dy))
    if sL is not None and sR is not None:
        denom = (sL - 2 * sC + sR)
        if abs(denom) > 1e-9:
            delta_x = 0.5 * (sL - sR) / denom
            if -1.0 < delta_x < 1.0:
                refined_dx += delta_x

    return refined_dx, refined_dy, best_score


# =========================================================
# DÉTECTION DES TRIANGLES BLEUS + CROP CARRÉ
# =========================================================

# Plage HSV pour le bleu DCS (icônes coalition bleue)
BLUE_HSV_LOW  = np.array([100, 150, 100])
BLUE_HSV_HIGH = np.array([130, 255, 255])

# Aire min/max en pixels pour filtrer le bruit et les gros blobs
TRIANGLE_AREA_MIN = 200
TRIANGLE_AREA_MAX = 80000


def detect_blue_triangles(canvas_pil: Image.Image, scale_factor: float = 1.0):
    """
    Détecte les triangles bleus (icônes DCS) dans l'image assemblée.
    Retourne une liste de centroïdes [(x, y), ...] dans les coordonnees du canvas D'ORIGINE.

    Si scale_factor < 1, l'image est reduite avant detection pour eviter MemoryError
    sur des canvases gigantesques. Les triangles sont ajustes en consequence.
    """
    if scale_factor < 1.0:
        new_w = max(1, int(canvas_pil.width * scale_factor))
        new_h = max(1, int(canvas_pil.height * scale_factor))
        print(f"   (Detection sur version reduite : {new_w}x{new_h}, scale={scale_factor:.3f})")
        small = canvas_pil.resize((new_w, new_h), Image.LANCZOS)
        img_bgr = cv2.cvtColor(np.array(small), cv2.COLOR_RGB2BGR)
        small.close()
    else:
        img_bgr = cv2.cvtColor(np.array(canvas_pil), cv2.COLOR_RGB2BGR)

    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)

    mask = cv2.inRange(hsv, BLUE_HSV_LOW, BLUE_HSV_HIGH)

    # Nettoyage morphologique
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Ajuster les seuils d'aire au scaling
    area_min = TRIANGLE_AREA_MIN * (scale_factor ** 2)
    area_max = TRIANGLE_AREA_MAX * (scale_factor ** 2)

    centroids = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < area_min or area > area_max:
            continue

        # Approximation polygonale
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.04 * peri, True)

        # Triangle = 3 sommets (tolérance: 3 à 5 pour les formes légèrement arrondies)
        if 3 <= len(approx) <= 5:
            M = cv2.moments(cnt)
            if M["m00"] < 1e-6:
                continue
            cx = int(M["m10"] / M["m00"])
            cy = int(M["m01"] / M["m00"])
            # Repasser en coordonnees du canvas d'origine
            cx_orig = int(cx / scale_factor)
            cy_orig = int(cy / scale_factor)
            centroids.append((cx_orig, cy_orig))
            print(f"   🔺 Triangle bleu détecté : ({cx_orig}, {cy_orig})  aire={int(area / scale_factor**2)}px²  sommets={len(approx)}")

    return centroids


def filter_corner_triangles(centroids, canvas_w, canvas_h):
    """
    Si on a plus de 4 triangles, on garde les 4 plus proches des coins du canvas.
    Cela elimine les triangles parasites au milieu de la carte.
    """
    if len(centroids) <= 4:
        return centroids

    corners = [
        (0, 0),                    # top-left
        (canvas_w, 0),             # top-right
        (0, canvas_h),             # bottom-left
        (canvas_w, canvas_h),      # bottom-right
    ]

    selected = []
    used = set()
    for corner in corners:
        best_idx = None
        best_dist = float('inf')
        for i, (cx, cy) in enumerate(centroids):
            if i in used:
                continue
            dist = (cx - corner[0]) ** 2 + (cy - corner[1]) ** 2
            if dist < best_dist:
                best_dist = dist
                best_idx = i
        if best_idx is not None:
            selected.append(centroids[best_idx])
            used.add(best_idx)

    print(f"   🎯 Filtre coins : {len(centroids)} → {len(selected)} triangles retenus")
    return selected


def crop_square_from_markers(canvas_pil: Image.Image, centroids):
    """
    À partir de 2, 3 ou 4 centroïdes définissant les coins d'un carré,
    calcule le crop carré et le retourne.
    """
    n = len(centroids)
    xs = [p[0] for p in centroids]
    ys = [p[1] for p in centroids]

    if n >= 4:
        # 4 coins : bounding box directe
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)
        side = max(x_max - x_min, y_max - y_min)

    elif n == 3:
        # 3 coins : on déduit le côté et le coin manquant
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)
        side = max(x_max - x_min, y_max - y_min)

    elif n == 2:
        dx = abs(xs[1] - xs[0])
        dy = abs(ys[1] - ys[0])

        # Diagonale (les deux coordonnées diffèrent significativement)
        if dx > 0.3 * max(dx, dy, 1) and dy > 0.3 * max(dx, dy, 1):
            side = max(dx, dy)
            x_min = min(xs)
            y_min = min(ys)
        # Même côté horizontal
        elif dx > dy:
            side = dx
            x_min = min(xs)
            y_min = min(ys)
        # Même côté vertical
        else:
            side = dy
            x_min = min(xs)
            y_min = min(ys)
    else:
        return None

    # Forcer le carré parfait
    cx_center = x_min + (max(xs) - min(xs)) / 2
    cy_center = y_min + (max(ys) - min(ys)) / 2
    half = side / 2

    crop_x0 = max(0, int(cx_center - half))
    crop_y0 = max(0, int(cy_center - half))
    crop_x1 = min(canvas_pil.width, int(cx_center + half))
    crop_y1 = min(canvas_pil.height, int(cy_center + half))

    # Ajuster pour garder un carré parfait
    actual_w = crop_x1 - crop_x0
    actual_h = crop_y1 - crop_y0
    final_side = min(actual_w, actual_h)
    crop_x1 = crop_x0 + final_side
    crop_y1 = crop_y0 + final_side

    print(f"   📐 Crop carré : ({crop_x0}, {crop_y0}) → ({crop_x1}, {crop_y1})  côté={final_side}px")
    return canvas_pil.crop((crop_x0, crop_y0, crop_x1, crop_y1))


def confident_dx(A, B, stats):
    """
    Retourne dx horizontal. Logique nominal-first + clampage :
    1. NCC < seuil -> nominal (TILE_W)
    2. NCC >= seuil mais correction > MAX_CORRECTION -> nominal (faux match)
    3. NCC >= seuil et correction <= MAX_CORRECTION -> correction appliquee
    """
    dx_measured, score = best_dx_horizontal(A, B)
    correction = abs(dx_measured - TILE_W)

    if score >= NCC_CONFIDENCE and correction <= MAX_CORRECTION:
        stats["measured"] += 1
        return dx_measured, score, True
    else:
        stats["nominal"] += 1
        reason = "low_ncc" if score < NCC_CONFIDENCE else f"clamp({correction}px)"
        return TILE_W, score, False


def confident_dy(A, B, stats):
    """
    Retourne (dx, dy) vertical. Logique nominal-first + clampage :
    Nominal = dx=0, dy=TILE_H
    """
    dx_measured, dy_measured, score = best_dxdy_vertical(A, B)
    correction_dx = abs(dx_measured - 0)
    correction_dy = abs(dy_measured - TILE_H)

    if score >= NCC_CONFIDENCE and correction_dx <= MAX_CORRECTION and correction_dy <= MAX_CORRECTION:
        stats["measured"] += 1
        return dx_measured, dy_measured, score, True
    else:
        stats["nominal"] += 1
        return 0, TILE_H, score, False


def main():
    if len(sys.argv) < 3:
        print("Usage: py 2_recalage.py <input_folder> <output_folder>")
        sys.exit(1)

    in_folder = sys.argv[1]
    out_folder = sys.argv[2]
    ensure_dir(out_folder)

    tiles, min_r, min_c, R, C = find_tiles(in_folder)
    print(f"Detected grid: rows={R} cols={C} (min_r={min_r}, min_c={min_c})")

    # Auto-detection de la taille des tuiles
    tw, th = detect_tile_size(tiles)
    init_params_from_tile_size(tw, th)
    print(f"Tile size detected: {TILE_W} x {TILE_H}")
    print(f"Search params: SEARCH_X={SEARCH_X} SEARCH_Y={SEARCH_Y} SEARCH_DX_VERT={SEARCH_DX_VERT} BAND={BAND_W}x{BAND_H}")
    print(f"Confidence: NCC>={NCC_CONFIDENCE}, clamp={MAX_CORRECTION}px")
    print()

    # --- Remap des coordonnees (rr_abs -> 0-based) ---
    tile_paths = {}
    for (rr_abs, cc_abs), path in tiles.items():
        tile_paths[(rr_abs - min_r, cc_abs - min_c)] = path

    # --- Lazy loader avec cache (max ~20 tuiles en RAM) ---
    _gray_cache = {}
    _cache_order = []
    _CACHE_MAX = 20

    def get_gray(r, c):
        key = (r, c)
        if key in _gray_cache:
            return _gray_cache[key]
        if key not in tile_paths:
            return None
        g = load_gray(tile_paths[key])
        _gray_cache[key] = g
        _cache_order.append(key)
        while len(_cache_order) > _CACHE_MAX:
            old = _cache_order.pop(0)
            _gray_cache.pop(old, None)
        return g

    # --- Wrapper NCC avec clampage (plus de texture check) ---
    # On laisse le NCC tourner dans tous les cas.
    # Si zone uniforme -> NCC score sera bas -> on garde nominal.
    # Si zone texturee -> NCC score sera bon -> on applique si correction raisonnable.
    def measure_dx(r, c1, c2):
        """Mesure dx entre (r,c1) et (r,c2=c1+1). Retourne (correction, fiable)."""
        A = get_gray(r, c1)
        B = get_gray(r, c2)
        if A is None or B is None:
            return 0.0, False

        dx, score = best_dx_horizontal(A, B)
        correction = dx - TILE_W
        if score >= NCC_CONFIDENCE and abs(correction) <= MAX_CORRECTION:
            return float(correction), True
        return 0.0, False

    def measure_dxdy_vert(r1, r2, c):
        """Mesure (dx, dy correction) entre (r1,c) et (r2=r1+1,c). Retourne (cdx, cdy, fiable)."""
        A = get_gray(r1, c)
        B = get_gray(r2, c)
        if A is None or B is None:
            return 0.0, 0.0, False

        dx, dy, score = best_dxdy_vertical(A, B)
        cdx = float(dx)
        cdy = float(dy - TILE_H)
        if score >= NCC_CONFIDENCE and abs(cdx) <= MAX_CORRECTION and abs(cdy) <= MAX_CORRECTION:
            return cdx, cdy, True
        return 0.0, 0.0, False

    # ======================================================
    # PASS 1 : Correction horizontale (drift global + outliers par-col)
    # ======================================================
    print("--- Pass 1 : Mesure du drift horizontal ---")

    # 1. Mesures par transition de colonne
    col_measures_dx = [[] for _ in range(C)]   # col_measures_dx[c] = mesures pour transition (c-1 -> c)

    for c in range(1, C):
        for r in range(R):
            corr, ok = measure_dx(r, c - 1, c)
            if ok:
                col_measures_dx[c].append(corr)

    # 2. Drift global
    all_dx = [v for col in col_measures_dx for v in col]
    n_total_h = (C - 1) * R
    n_ok_h = len(all_dx)

    if all_dx:
        all_dx_sorted = sorted(all_dx)
        q25 = n_ok_h // 4
        q75 = n_ok_h - n_ok_h // 4
        trimmed_dx = all_dx_sorted[q25:q75] if q75 > q25 else all_dx_sorted
        global_dx_corr = sum(trimmed_dx) / len(trimmed_dx)
        import statistics as _stats
        std_dx = _stats.stdev(all_dx) if len(all_dx) > 1 else 0.0
        print(f"  {n_ok_h}/{n_total_h} mesures fiables")
        print(f"  Drift horizontal global : dx_corr={global_dx_corr:+.2f} (std={std_dx:.2f})")
    else:
        global_dx_corr = 0.0
        print(f"  Aucune mesure fiable, derive nulle")

    # 3. Outliers par transition de colonne
    OUTLIER_THRESHOLD_H = 15.0
    col_dx_local = [global_dx_corr] * C
    n_outliers_h = 0

    for c in range(1, C):
        if len(col_measures_dx[c]) >= 3:
            sorted_local = sorted(col_measures_dx[c])
            n_loc = len(sorted_local)
            q25l = n_loc // 4
            q75l = n_loc - n_loc // 4
            trimmed_local = sorted_local[q25l:q75l] if q75l > q25l else sorted_local
            local_dx = sum(trimmed_local) / len(trimmed_local)
            div = abs(local_dx - global_dx_corr)
            if div > OUTLIER_THRESHOLD_H:
                col_dx_local[c] = local_dx
                n_outliers_h += 1
                print(f"  ⚠️ Outlier col {c-1}->{c}: dx={local_dx:+.2f} "
                      f"(divergence={div:.2f}, {len(col_measures_dx[c])} mesures)")

    if n_outliers_h:
        print(f"  {n_outliers_h} transitions outlier corrigees individuellement")

    # 4. Construction des X positions
    row_pos_x = [[0.0] * C for _ in range(R)]
    for c in range(1, C):
        x = row_pos_x[0][c - 1] + TILE_W + col_dx_local[c]
        for r in range(R):
            row_pos_x[r][c] = x
    print()

    # ======================================================
    # PASS 2 : Corrections verticales partagees (drag uniforme)
    # ======================================================
    print("--- Pass 2 : Corrections verticales partagees ---")

    # Le drag SOUTH deplace toute la carte uniformement.
    # Donc cdy et cdx (derive horizontale du drag sud) doivent etre les MEMES
    # pour toutes les colonnes a une transition de rangee donnee.
    # On mesure dans chaque colonne et on MOYENNE.

    # ======================================================
    # PASS 2 : Correction verticale (drift global + outliers par-row)
    # ======================================================
    print("--- Pass 2 : Mesure du drift vertical ---")

    # 1. Mesurer toutes les paires verticales et organiser par row
    row_measures_dy = [[] for _ in range(R)]    # row_measures_dy[r] = liste de cdy pour la transition (r-1 -> r)
    row_measures_cdx = [[] for _ in range(R)]

    for r in range(1, R):
        for c in range(C):
            cdx, cdy, ok = measure_dxdy_vert(r - 1, r, c)
            if ok:
                row_measures_dy[r].append(cdy)
                row_measures_cdx[r].append(cdx)

    # 2. Drift global (mediane sur toutes les mesures)
    all_dy = [v for row in row_measures_dy for v in row]
    all_cdx = [v for row in row_measures_cdx for v in row]
    n_total = (R - 1) * C
    n_ok = len(all_dy)

    # 2. Drift global (moyenne trimmee : 25%-75% pour eliminer outliers tout en
    # gardant la precision sub-pixel grace a la moyenne)
    if all_dy:
        all_dy_sorted = sorted(all_dy)
        all_cdx_sorted = sorted(all_cdx)
        q25 = n_ok // 4
        q75 = n_ok - n_ok // 4
        trimmed_dy = all_dy_sorted[q25:q75] if q75 > q25 else all_dy_sorted
        trimmed_cdx = all_cdx_sorted[q25:q75] if q75 > q25 else all_cdx_sorted
        global_dy_corr = sum(trimmed_dy) / len(trimmed_dy)
        global_cdx_corr = sum(trimmed_cdx) / len(trimmed_cdx)

        import statistics as _stats
        std_dy = _stats.stdev(all_dy) if len(all_dy) > 1 else 0.0
        std_cdx = _stats.stdev(all_cdx) if len(all_cdx) > 1 else 0.0

        print(f"  {n_ok}/{n_total} mesures fiables")
        print(f"  Drift vertical global : dy_corr={global_dy_corr:+.2f} (std={std_dy:.2f})")
        print(f"  Drift horizontal global : cdx={global_cdx_corr:+.2f} (std={std_cdx:.2f})")
    else:
        global_dy_corr = 0.0
        global_cdx_corr = 0.0
        std_dy = 0.0
        std_cdx = 0.0
        print(f"  Aucune mesure fiable, derive nulle")

    # 3. Detection d'outliers par row : si la mediane locale diverge fortement
    # du drift global, c'est un drag ayant glisse anormalement (popup, lag, etc.)
    OUTLIER_THRESHOLD = 15.0  # px : seuil de divergence pour declarer un outlier

    row_dy_local = [global_dy_corr] * R   # par defaut = global
    row_cdx_local = [global_cdx_corr] * R
    n_outliers = 0

    for r in range(1, R):
        if len(row_measures_dy[r]) >= 3:
            n_loc = len(row_measures_dy[r])
            sorted_dy = sorted(row_measures_dy[r])
            sorted_cdx = sorted(row_measures_cdx[r])
            q25l = n_loc // 4
            q75l = n_loc - n_loc // 4
            trimmed_dy = sorted_dy[q25l:q75l] if q75l > q25l else sorted_dy
            trimmed_cdx = sorted_cdx[q25l:q75l] if q75l > q25l else sorted_cdx
            local_dy = sum(trimmed_dy) / len(trimmed_dy)
            local_cdx = sum(trimmed_cdx) / len(trimmed_cdx)

            div_dy = abs(local_dy - global_dy_corr)
            div_cdx = abs(local_cdx - global_cdx_corr)

            if div_dy > OUTLIER_THRESHOLD or div_cdx > OUTLIER_THRESHOLD:
                row_dy_local[r] = local_dy
                row_cdx_local[r] = local_cdx
                n_outliers += 1
                print(f"  ⚠️ Outlier row {r-1}->{r}: dy={local_dy:+.2f} cdx={local_cdx:+.2f} "
                      f"(divergence dy={div_dy:.2f} cdx={div_cdx:.2f}, {len(row_measures_dy[r])} mesures)")

    if n_outliers:
        print(f"  {n_outliers} transitions outlier corrigees individuellement")

    # 4. Construction des positions cumulees
    row_dy = [0.0] * R
    row_cdx = [0.0] * R
    for r in range(1, R):
        row_dy[r] = row_dy[r - 1] + row_dy_local[r]
        row_cdx[r] = row_cdx[r - 1] + row_cdx_local[r]
    print()

    # ======================================================
    # PASS 3 : Construction des positions
    # ======================================================
    print("--- Pass 3 : Construction des positions ---")

    # Cumul des corrections + interpolation entre ancres
    # row_dy[r] et row_cdx[r] contiennent deja la derive cumulee (r * drift_uniforme)

    # Construire les positions finales : MEME correction verticale pour toutes les colonnes
    pos = [[None for _ in range(C)] for __ in range(R)]
    for r in range(R):
        for c in range(C):
            if (r, c) in tile_paths:
                px = row_pos_x[r][c] + row_cdx[r]
                py = float(r * TILE_H) + row_dy[r]
                pos[r][c] = (px, py)

    print()

    # ======================================================
    # ASSEMBLAGE
    # ======================================================

    # Collect bounds
    xs, ys = [], []
    for r in range(R):
        for c in range(C):
            if pos[r][c] is None:
                continue
            xs.append(pos[r][c][0])
            ys.append(pos[r][c][1])

    if not xs:
        raise RuntimeError("No positioned tiles (pos empty).")

    min_x, min_y = min(xs), min(ys)
    max_x, max_y = max(xs), max(ys)

    W = int(math.ceil((max_x - min_x) + TILE_W))
    H = int(math.ceil((max_y - min_y) + TILE_H))
    print(f"Canvas: {W}x{H}")

    canvas = Image.new("RGB", (W, H), (0, 0, 0))

    # Paste tiles (lazy, one at a time for memory)
    count = 0
    total = len(tile_paths)
    for (r, c), path in tile_paths.items():
        if pos[r][c] is None:
            continue
        x = int(round(pos[r][c][0] - min_x))
        y = int(round(pos[r][c][1] - min_y))
        im = Image.open(path).convert("RGB")
        canvas.paste(im, (x, y))
        im.close()
        count += 1
        if count % 50 == 0 or count == total:
            print(f"  Paste {count}/{total}")

    # Retile
    for r in range(R):
        for c in range(C):
            x0 = c * TILE_W
            y0 = r * TILE_H
            x1 = x0 + TILE_W
            y1 = y0 + TILE_H

            tile = Image.new("RGB", (TILE_W, TILE_H), (0, 0, 0))

            right = min(x1, W)
            lower = min(y1, H)

            if right > x0 and lower > y0:
                crop = canvas.crop((x0, y0, right, lower))
                tile.paste(crop, (0, 0))

            out_name = f"{OUT_TILE_PREFIX}{r:03d}_{c:03d}.png"
            tile.save(os.path.join(out_folder, out_name), "PNG")

    # Nom de base pour les fichiers d'assemblage (derivé du nom du dossier)
    base_name = os.path.basename(out_folder.rstrip(os.sep))
    if base_name.endswith("_recalage"):
        base_name = base_name[:-len("_recalage")]

    canvas.save(os.path.join(out_folder, f"{base_name}_ASSEMBLAGE.png"), "PNG")

    # --- Version JPEG allégée de l'assemblage (35%, qualité Photoshop 10/12) ---
    JPEG_SCALE = 0.35
    JPEG_QUALITY = 78  # PIL ~78 ≈ Photoshop 10/12
    new_w = max(1, int(W * JPEG_SCALE))
    new_h = max(1, int(H * JPEG_SCALE))
    print(f"📸 Génération JPEG assemblage {new_w}x{new_h} (qualité {JPEG_QUALITY})...")
    canvas_small = canvas.resize((new_w, new_h), Image.LANCZOS)
    assemblage_light_name = f"{base_name}_ASSEMBLAGE_light.jpg"
    jpeg_path = os.path.join(out_folder, assemblage_light_name)
    canvas_small.save(jpeg_path, "JPEG", quality=JPEG_QUALITY, optimize=True)
    print(f"   → {jpeg_path}")

    # --- Détection des triangles bleus et crop carré ---
    print("\n🔍 Recherche des triangles bleus (marqueurs de zone)...")

    # Adapter le scale en fonction de la taille du canvas
    # On vise max ~500M pixels pour la detection (~1.5 Go RAM en RGB)
    canvas_pixels = canvas.width * canvas.height
    MAX_DETECT_PIXELS = 500_000_000
    if canvas_pixels > MAX_DETECT_PIXELS:
        detect_scale = (MAX_DETECT_PIXELS / canvas_pixels) ** 0.5
    else:
        detect_scale = 1.0

    centroids = detect_blue_triangles(canvas, scale_factor=detect_scale)
    centroids = filter_corner_triangles(centroids, canvas.width, canvas.height)

    resized_light_name = None  # pour le dossier _Resized

    if len(centroids) >= 2:
        print(f"   ✅ {len(centroids)} triangle(s) détecté(s), calcul du crop carré...")
        cropped = crop_square_from_markers(canvas, centroids)

        if cropped is not None:
            # PNG pleine résolution
            resized_png_name = f"{base_name}_resized.png"
            resized_png = os.path.join(out_folder, resized_png_name)
            cropped.save(resized_png, "PNG")
            print(f"   → {resized_png}  ({cropped.width}x{cropped.height})")

            # JPEG compressé à 35%
            rw = max(1, int(cropped.width * JPEG_SCALE))
            rh = max(1, int(cropped.height * JPEG_SCALE))
            print(f"📸 Génération JPEG resized {rw}x{rh} (qualité {JPEG_QUALITY})...")
            cropped_small = cropped.resize((rw, rh), Image.LANCZOS)
            resized_light_name = f"{base_name}_resized_light.jpg"
            resized_jpg = os.path.join(out_folder, resized_light_name)
            cropped_small.save(resized_jpg, "JPEG", quality=JPEG_QUALITY, optimize=True)
            print(f"   → {resized_jpg}")
        else:
            print("   ⚠️ Impossible de calculer le crop (marqueurs trop proches du bord ?).")
    elif len(centroids) == 1:
        print("   ⚠️ Un seul triangle détecté, il en faut au moins 2 pour définir le carré.")
    else:
        print("   ⚠️ Aucun triangle bleu détecté. Pas de crop automatique.")

    # ======================================================
    # DOSSIER _Resized : tuiles compressees + assemblages
    # ======================================================
    # Determination du dossier _Resized a partir du nom du dossier de recalage
    if out_folder.endswith("_recalage"):
        resized_folder = out_folder[:-len("_recalage")] + "_Resized"
    else:
        resized_folder = out_folder + "_Resized"
    ensure_dir(resized_folder)

    print(f"\n📦 Generation du dossier compresse : {resized_folder}")

    # 1. Convertir toutes les tuiles recalees en JPEG compresse (meme nom)
    print("   Compression des tuiles individuelles...")
    n_tiles_resized = 0
    for r in range(R):
        for c in range(C):
            src_name = f"{OUT_TILE_PREFIX}{r:03d}_{c:03d}.png"
            src_path = os.path.join(out_folder, src_name)
            if not os.path.isfile(src_path):
                continue
            # Meme nomenclature mais .jpg
            dst_name = f"{OUT_TILE_PREFIX}{r:03d}_{c:03d}.jpg"
            dst_path = os.path.join(resized_folder, dst_name)

            tile_im = Image.open(src_path).convert("RGB")
            # Reduction proportionnelle (meme JPEG_SCALE que les assemblages)
            tw_small = max(1, int(tile_im.width * JPEG_SCALE))
            th_small = max(1, int(tile_im.height * JPEG_SCALE))
            tile_im_small = tile_im.resize((tw_small, th_small), Image.LANCZOS)
            tile_im_small.save(dst_path, "JPEG", quality=JPEG_QUALITY, optimize=True)
            tile_im.close()
            n_tiles_resized += 1
    print(f"   {n_tiles_resized} tuiles compressees")

    # 2. Copier les assemblages light dans le meme dossier
    import shutil
    assemblage_jpg = os.path.join(out_folder, assemblage_light_name)
    if os.path.isfile(assemblage_jpg):
        shutil.copy2(assemblage_jpg, os.path.join(resized_folder, assemblage_light_name))
        print(f"   Copie : {assemblage_light_name}")

    if resized_light_name:
        resized_jpg_src = os.path.join(out_folder, resized_light_name)
        if os.path.isfile(resized_jpg_src):
            shutil.copy2(resized_jpg_src, os.path.join(resized_folder, resized_light_name))
            print(f"   Copie : {resized_light_name}")

    print(f"📦 Dossier _Resized pret : {resized_folder}\n")

    print("✅ Done.")
    print(f"-> corrected tiles in: {out_folder}")
    print(f"-> compressed tiles in: {resized_folder}")


if __name__ == "__main__":
    main()
