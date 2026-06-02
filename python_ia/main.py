# main.py
import cv2
import face_recognition
import numpy as np
import time
import os
import json
import sqlite3
import threading
import math
import queue
from multiprocessing import Process, Manager, Queue
from collections import deque
from datetime import datetime
from fastapi import FastAPI, Response, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from ultralytics import YOLO 
import uvicorn
from jose import jwt 
from dotenv import load_dotenv

from core.face_engine import FaceEngine
from core.pose_engine import PoseEngine

# ==========================================
# GESTÃO DE CAMINHOS ABSOLUTOS
# ==========================================
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ENV_PATH = os.path.join(BASE_DIR, '.env')
load_dotenv(ENV_PATH)

app = FastAPI(title="SmartClass - AI Video Worker")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"], max_age=86400)

DB_PATH = os.path.join(BASE_DIR, 'data', 'database.db')
DATA_FACES = os.path.join(BASE_DIR, 'data', 'faces')
DATA_ENCODINGS = os.path.join(BASE_DIR, 'data', 'encodings.pickle')
DATA_CLIPS = os.path.join(BASE_DIR, 'data', 'clips')
DATA_SCREENSHOTS = os.path.join(BASE_DIR, 'data', 'screenshots')

os.makedirs(DATA_CLIPS, exist_ok=True)
os.makedirs(DATA_SCREENSHOTS, exist_ok=True)

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    print("❌ ERRO FATAL: SECRET_KEY não encontrada no arquivo .env")
    exit(1)
    
ALGORITHM = "HS256"

# ==========================================
# INICIALIZAÇÃO GLOBAL DOS MODELOS DE IA
# ==========================================
face_engine = FaceEngine(data_path=DATA_FACES, encodings_file=DATA_ENCODINGS)
pose_engine = PoseEngine()

# Detector de Celular
phone_detector_path = os.path.join(BASE_DIR, 'python_ia', 'yolov8n_ncnn_model') # Ajuste leve de path para garantir que pegue o modelo na pasta certa
if os.path.exists(phone_detector_path):
    phone_detector = YOLO(phone_detector_path, task="detect")
    print("✅ YOLO-Celular NCNN (Edge) carregado com sucesso!")
else:
    phone_detector = YOLO('yolov8n.pt') 

# Detector de Rostos (Tratado como POSE)
face_detector_path = os.path.join(BASE_DIR, 'python_ia', 'yolov8n-face_ncnn_model') # Ajuste leve de path
try:
    if os.path.exists(face_detector_path):
        face_detector = YOLO(face_detector_path, task="pose") 
        print("✅ YOLO-Face NCNN (Edge) carregado com sucesso!")
    else:
        face_detector = YOLO(os.path.join(BASE_DIR, 'python_ia', 'yolov8n-face.pt')) 
        print("✅ YOLO-Face PyTorch (Standard) carregado com sucesso!")
except Exception as e:
    print(f"⚠️ Aviso ao carregar face_detector: {e}")
    face_detector = YOLO('yolov8n.pt') 

def cleanup_old_clips():
    while True:
        try:
            now = time.time()
            for folder in [DATA_CLIPS, DATA_SCREENSHOTS]:
                for f in os.listdir(folder):
                    fpath = os.path.join(folder, f)
                    if os.path.isfile(fpath) and now - os.path.getmtime(fpath) > 86400:
                        os.remove(fpath)
        except: pass
        time.sleep(3600) 

threading.Thread(target=cleanup_old_clips, daemon=True).start()

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=20.0)
    conn.execute('PRAGMA journal_mode=WAL;')
    conn.row_factory = sqlite3.Row
    return conn

@app.post("/api/reload_faces")
def reload_faces(background_tasks: BackgroundTasks):
    background_tasks.add_task(face_engine.generate_all_encodings)
    return {"status": "Recarregando em background..."}

class RTSPCamera:
    def __init__(self, src):
        self.src = src
        self.cap = None
        self.ret = False
        self.frame = None
        self.running = True
        self.lock = threading.Lock() 
        self.thread = threading.Thread(target=self.update, args=())
        self.thread.daemon = True
        self.thread.start()

    def update(self):
        if str(self.src).isdigit(): 
            self.cap = cv2.VideoCapture(int(self.src))
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        else: 
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay|stimeout;5000000"
            self.cap = cv2.VideoCapture(self.src, cv2.CAP_FFMPEG)
            
        if self.cap and self.cap.isOpened():
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        else:
            self.running = False
            return

        erros = 0
        while self.running:
            ret, frame = self.cap.read()
            if ret: 
                if self.cap.get(cv2.CAP_PROP_FRAME_COUNT) > 5:
                    self.cap.grab()
                    continue
                with self.lock: 
                    self.ret = True
                    self.frame = cv2.resize(frame, (640, 480)) 
                erros = 0
            else:
                erros += 1
                if erros > 50: 
                    self.running = False
                    break
                time.sleep(0.05) 
            
        if self.cap:
            try: self.cap.release(); time.sleep(0.1)
            except: pass

    def read(self):
        with self.lock:
            if self.frame is None: return False, None
            return self.ret, self.frame.copy()

    def release(self):
        self.running = False
        try:
            if self.thread and self.thread.is_alive(): self.thread.join(timeout=1.5)
        except BaseException: pass 

def save_clip(frames_list, filepath):
    if not frames_list: return
    out = None
    try:
        h, w = frames_list[0].shape[:2]
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(filepath, fourcc, 10.0, (w, h))
        for f in frames_list:
            out.write(f)
        print(f"🎬 Clipe Salvo com Sucesso: {filepath}")
    except Exception as e:
        print(f"❌ Erro ao tentar salvar vídeo: {e}")
    finally:
        if out is not None:
            out.release()

@app.get("/play_clip/{filename}")
def play_clip(filename: str):
    filepath = os.path.join(DATA_CLIPS, filename)
    def generate():
        for _ in range(15):
            if os.path.exists(filepath): break
            time.sleep(0.2)
            
        if not os.path.exists(filepath):
            blank = np.zeros((480, 640, 3), dtype=np.uint8)
            cv2.putText(blank, "VÍDEO PROCESSANDO...", (130, 240), cv2.FONT_HERSHEY_SIMPLEX, 1, (0,200,255), 2)
            ret, buffer = cv2.imencode('.jpg', blank)
            yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
            return

        cap = cv2.VideoCapture(filepath)
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ret, frame = cap.read()
                if not ret: break
                time.sleep(1.0)
                
            ret, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
            yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
            time.sleep(0.08) 
        cap.release()
    return StreamingResponse(generate(), media_type="multipart/x-mixed-replace; boundary=frame")


def gerar_frames_mapeamento(sala_id: int):
    conn = get_db(); cursor = conn.cursor()
    cursor.execute('SELECT camera_url FROM salas WHERE id=?', (sala_id,))
    row = cursor.fetchone(); conn.close()
    if not row: return
    
    blank_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.putText(blank_frame, "CONECTANDO CAMERA...", (140, 240), cv2.FONT_HERSHEY_SIMPLEX, 1, (255,255,255), 2)
    ret, buffer = cv2.imencode('.jpg', blank_frame)
    yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')

    cap = RTSPCamera(row['camera_url'])
    erros_tentativas = 0
    try:
        while cap.running or erros_tentativas < 50:
            ret, frame = cap.read()
            if not ret or frame is None: 
                erros_tentativas += 1
                time.sleep(0.1)
                continue
            erros_tentativas = 0
            ret, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 50])
            yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
            time.sleep(0.05) 
    except Exception: pass 
    finally: cap.release()

# =====================================================================================
# WORKER DA IA ISOLADO EM UM PROCESSO (FUGINDO DO GIL)
# =====================================================================================
def ia_process_worker(shared_state, frame_queue, clip_queue, aula_dict, zonas, alunos_dict, assentos_aula, db_path, data_screenshots_path):
    os.makedirs(data_screenshots_path, exist_ok=True)

    def get_local_db():
        conn = sqlite3.connect(db_path, timeout=20.0)
        conn.execute('PRAGMA journal_mode=WAL;')
        conn.row_factory = sqlite3.Row
        return conn

    def save_screenshot_robust(filename, frame):
        try:
            full_path = os.path.join(data_screenshots_path, filename)
            cv2.imwrite(full_path, frame)
            print(f"📸 Screenshot salvo com sucesso: {full_path}")
        except Exception as e:
            print(f"❌ Falha ao salvar screenshot ({filename}): {e}")

    active_students = {}
    last_alert_times = {}
    aluno_ultimo_visto = {}
    aluno_alertado_sumico = set()
    TEMPO_EVASAO = 1200 
    TEMPO_CELULAR = 2
    celular_timers = {}
    aluno_alertado_celular = set()
    last_celular_time = {} 
    TEMPO_DISTRACAO = 5
    distracao_timers = {}
    aluno_alertado_distracao = set()
    last_distracao_time = {} 
    
    FACE_INTERVAL = 0.5 
    last_ia_time = 0

    while shared_state.get("running", True):
        try:
            agora = time.time()
            if agora - last_ia_time > FACE_INTERVAL:
                if not frame_queue.empty():
                    try:
                        ia_frame = frame_queue.get_nowait()
                    except queue.Empty:
                        continue
                else:
                    time.sleep(0.05)
                    continue

                last_ia_time = agora
                live_status_dict = {}
                is_fighting_now = False

                alerts, pose_results = pose_engine.analyze_frame(ia_frame)
                conn = get_local_db()
                
                looking_down_boxes = []
                persons = []
                try:
                    for r_pose in pose_results:
                        if r_pose.keypoints is not None and hasattr(r_pose.keypoints, 'xy'):
                            for kpts, box in zip(r_pose.keypoints.xy, r_pose.boxes.xyxy):
                                if len(kpts) > 10:
                                    nose = kpts[0]; l_shoulder = kpts[5]; r_shoulder = kpts[6]
                                    l_wrist = kpts[9]; r_wrist = kpts[10]
                                    bx1, by1, bx2, by2 = box
                                    
                                    persons.append({'box': (int(bx1), int(by1), int(bx2), int(by2)), 'nose': nose, 'wrists': (l_wrist, r_wrist), 'shoulders': (l_shoulder, r_shoulder)})
                                    
                                    if nose[1] > 0 and l_shoulder[1] > 0 and r_shoulder[1] > 0:
                                        shoulder_avg_y = (l_shoulder[1] + r_shoulder[1]) / 2
                                        if nose[1] > (shoulder_avg_y + 10): 
                                            looking_down_boxes.append((int(nose[0]), int(nose[1])))
                except: pass

                for i in range(len(persons)):
                    for j in range(i + 1, len(persons)):
                        p1 = persons[i]; p2 = persons[j]
                        ix_min, iy_min = max(p1['box'][0], p2['box'][0]), max(p1['box'][1], p2['box'][1])
                        ix_max, iy_max = min(p1['box'][2], p2['box'][2]), min(p1['box'][3], p2['box'][3])
                        
                        if ix_min < ix_max and iy_min < iy_max:
                            inter_area = (ix_max - ix_min) * (iy_max - iy_min)
                            p1_area = (p1['box'][2] - p1['box'][0]) * (p1['box'][3] - p1['box'][1])
                            if inter_area > 0.3 * p1_area: 
                                p1_raised = (0 < p1['wrists'][0][1] < p1['shoulders'][0][1]) or (0 < p1['wrists'][1][1] < p1['shoulders'][1][1])
                                p2_raised = (0 < p2['wrists'][0][1] < p2['shoulders'][0][1]) or (0 < p2['wrists'][1][1] < p2['shoulders'][1][1])
                                if p1_raised and p2_raised: is_fighting_now = True; break
                    if is_fighting_now: break
                
                if is_fighting_now and (agora - last_alert_times.get('briga', 0) > 15):
                    last_alert_times['briga'] = agora
                    v_filename = f"briga_{int(agora)}.mp4" 
                    img_filename = f"briga_img_{int(agora)}.jpg"
                    
                    save_screenshot_robust(img_filename, ia_frame)
                    
                    conn.execute("INSERT INTO alertas (aula_id, mensagem, data_hora, video_file, image_file) VALUES (?, ?, ?, ?, ?)", (aula_dict['id'], "🥊 BRIGA DETECTADA: Confusão ou agressão corporal na sala!", datetime.now().strftime("%Y-%m-%d %H:%M:%S"), v_filename, img_filename))
                    conn.commit()
                    clip_queue.put(v_filename)

                phone_boxes = []
                try:
                    results_obj = phone_detector(ia_frame, classes=[67], conf=0.35, imgsz=640, verbose=False)
                    for r_obj in results_obj:
                        for box in r_obj.boxes: 
                            x1, y1, x2, y2 = box.xyxy[0]
                            phone_boxes.append({'box': (int(x1), int(y1), int(x2), int(y2)), 'claimed': False})
                except: pass

                face_boxes_yolo = []
                try:
                    res_faces = face_detector(ia_frame, conf=0.40, imgsz=640, verbose=False)
                    for r_face in res_faces:
                        for box in r_face.boxes:
                            fx1, fy1, fx2, fy2 = box.xyxy[0]
                            face_boxes_yolo.append((int(fy1), int(fx2), int(fy2), int(fx1)))
                except: pass

                rgb_frame = cv2.cvtColor(ia_frame, cv2.COLOR_BGR2RGB)
                
                if len(face_boxes_yolo) == 0:
                    face_locations = face_recognition.face_locations(rgb_frame)
                else:
                    face_locations = face_boxes_yolo

                face_encodings = face_recognition.face_encodings(rgb_frame, face_locations)

                detected_students_info = []
                for (top, right, bottom, left), encoding in zip(face_locations, face_encodings):
                    matches = face_recognition.compare_faces(face_engine.known_encodings, encoding)
                    matricula_aluno = "Desconhecido"
                    if True in matches: matricula_aluno = face_engine.known_names[matches.index(True)]

                    cx, cy = (left + right) // 2, (top + bottom) // 2
                    detected_students_info.append({
                        'matricula': matricula_aluno,
                        'box': (top, right, bottom, left),
                        'center': (cx, cy)
                    })
                    
                for p in phone_boxes:
                    px1, py1, px2, py2 = p['box']
                    pcx, pcy = (px1 + px2) // 2, (py1 + py2) // 2
                    min_dist = float('inf')
                    closest_mat = None
                    
                    for st in detected_students_info:
                        dist = math.hypot(pcx - st['center'][0], pcy - st['center'][1])
                        if dist < min_dist: 
                            min_dist = dist 
                            closest_mat = st['matricula']
                            
                    if closest_mat and min_dist < 800: 
                        p['claimed_by'] = closest_mat
                        p['claimed'] = True

                current_faces = []
                for st in detected_students_info:
                    matricula_aluno = st['matricula']
                    top, right, bottom, left = st['box']
                    cx, cy = st['center']

                    bancada_atual = "Área Livre"
                    for z in zonas:
                        poly = np.array(z['pontos'], np.int32)
                        if cv2.pointPolygonTest(poly, (cx, cy), False) >= 0: bancada_atual = z['nome']; break

                    if matricula_aluno != "Desconhecido" and matricula_aluno in alunos_dict:
                        aluno_ultimo_visto[matricula_aluno] = agora
                        if matricula_aluno in aluno_alertado_sumico: aluno_alertado_sumico.remove(matricula_aluno)
                        if matricula_aluno not in active_students or (agora - active_students[matricula_aluno] > 10):
                            conn.execute("INSERT INTO presenca (aluno_id, aula_id, bancada_atual, data_hora, tipo) VALUES (?, ?, ?, ?, 'PRESENTE')", (matricula_aluno, aula_dict['id'], bancada_atual, datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
                            conn.commit()
                            active_students[matricula_aluno] = agora

                    is_holding_phone = any(p.get('claimed_by') == matricula_aluno for p in phone_boxes)
                    is_head_down = any(math.hypot(nx - cx, ny - cy) < 150 for nx, ny in looking_down_boxes)
                    
                    if matricula_aluno != "Desconhecido" and matricula_aluno in alunos_dict:
                        if is_holding_phone:
                            live_status_dict[matricula_aluno] = "USANDO CELULAR"
                            last_celular_time[matricula_aluno] = agora
                            if matricula_aluno not in celular_timers: celular_timers[matricula_aluno] = agora
                            elif agora - celular_timers[matricula_aluno] > TEMPO_CELULAR:
                                if matricula_aluno not in aluno_alertado_celular:
                                    
                                    v_filename = f"celular_{int(agora)}_{matricula_aluno}.mp4"
                                    img_filename = f"celular_img_{int(agora)}_{matricula_aluno}.jpg"
                                    
                                    save_screenshot_robust(img_filename, ia_frame)

                                    conn.execute("INSERT INTO alertas (aula_id, mensagem, data_hora, video_file, image_file) VALUES (?, ?, ?, ?, ?)", (aula_dict['id'], f"📱 CELULAR: Aluno(a) {alunos_dict[matricula_aluno]} flagrado com aparelho.", datetime.now().strftime("%Y-%m-%d %H:%M:%S"), v_filename, img_filename))
                                    conn.commit()
                                    aluno_alertado_celular.add(matricula_aluno)
                                    clip_queue.put(v_filename)
                        
                        elif is_head_down:
                            live_status_dict[matricula_aluno] = "DISTRAÍDO"
                            last_distracao_time[matricula_aluno] = agora
                            if matricula_aluno not in distracao_timers: distracao_timers[matricula_aluno] = agora
                            elif agora - distracao_timers[matricula_aluno] > TEMPO_DISTRACAO:
                                if matricula_aluno not in aluno_alertado_distracao:
                                    conn.execute("INSERT INTO alertas (aula_id, mensagem, data_hora) VALUES (?, ?, ?)", (aula_dict['id'], f"😴 DISPERSÃO: Aluno(a) {alunos_dict[matricula_aluno]} desatento na aula.", datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
                                    conn.commit()
                                    aluno_alertado_distracao.add(matricula_aluno)
                        else:
                            if agora - last_celular_time.get(matricula_aluno, 0) < 2.0: 
                                is_holding_phone = True; live_status_dict[matricula_aluno] = "USANDO CELULAR"
                            elif agora - last_distracao_time.get(matricula_aluno, 0) < 5.0: 
                                is_head_down = True; live_status_dict[matricula_aluno] = "DISTRAÍDO"
                            else:
                                live_status_dict[matricula_aluno] = "FOCADO"
                                if matricula_aluno in celular_timers: del celular_timers[matricula_aluno]
                                if matricula_aluno in distracao_timers: del distracao_timers[matricula_aluno]
                                if matricula_aluno in aluno_alertado_celular: aluno_alertado_celular.remove(matricula_aluno)
                                if matricula_aluno in aluno_alertado_distracao: aluno_alertado_distracao.remove(matricula_aluno)

                    cor = (0, 0, 255) if is_holding_phone else ((0, 200, 255) if is_head_down else (66, 193, 122))
                    if bancada_atual == "Área Livre" or (assentos_aula.get(matricula_aluno) and bancada_atual != assentos_aula.get(matricula_aluno)): cor = (0, 200, 255)

                    nome_exibicao = alunos_dict.get(matricula_aluno, "Desconhecido")
                    if nome_exibicao != "Desconhecido":
                        status_tela = "Celular" if is_holding_phone else ("Distraido" if is_head_down else "Focado")
                        current_faces.append((top, right, bottom, left, nome_exibicao, bancada_atual, cor, status_tela))
                
                for mat, ult_visto in list(aluno_ultimo_visto.items()):
                    if agora - ult_visto > TEMPO_EVASAO:
                        if mat not in aluno_alertado_sumico:
                            conn.execute("INSERT INTO alertas (aula_id, mensagem, data_hora) VALUES (?, ?, ?)", (aula_dict['id'], f"🏃 EVASÃO: Aluno(a) {alunos_dict.get(mat, mat)} sumiu da câmera há 20 minutos.", datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
                            conn.commit()
                            aluno_alertado_sumico.add(mat)

                if len(live_status_dict) > 0:
                    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    for mat, st in live_status_dict.items():
                        conn.execute("INSERT OR REPLACE INTO live_status (aluno_matricula, status_atencao, atualizado_em) VALUES (?, ?, ?)", (mat, st, now_str))
                    conn.commit()

                conn.close()
                
                # Sincroniza estado para o Processo Principal desenhar a tela
                shared_state["faces"] = current_faces
                shared_state["fighting"] = is_fighting_now

            time.sleep(0.02)
        except Exception as e:
            print(f"❌ Erro no Processo Isolado da IA: {e}")
            time.sleep(1)

@app.get("/map_feed/{sala_id}")
def map_feed(sala_id: int, token: str = None):
    if token:
        try: jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        except: return Response(status_code=401)
    return StreamingResponse(gerar_frames_mapeamento(sala_id), media_type="multipart/x-mixed-replace; boundary=frame")


def gerar_frames_camera(usuario_id: int):
    conn = get_db(); cursor = conn.cursor()
    cursor.execute('SELECT s.camera_url, a.materia_id, a.sala_id, a.id FROM aulas a JOIN salas s ON a.sala_id = s.id WHERE a.status = "EM_ANDAMENTO" AND a.usuario_id = ? ORDER BY a.id DESC LIMIT 1', (usuario_id,))
    aula = cursor.fetchone()
    if not aula: conn.close(); return

    blank_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.putText(blank_frame, "INICIANDO IA...", (190, 240), cv2.FONT_HERSHEY_SIMPLEX, 1, (0,200,255), 2)
    ret, buffer = cv2.imencode('.jpg', blank_frame)
    yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')

    cap = RTSPCamera(aula['camera_url'])
    
    cursor.execute('SELECT nome_bancada, coordenadas_json FROM zonas_sala WHERE sala_id = ?', (aula['sala_id'],))
    zonas = [{"nome": r['nome_bancada'], "pontos": json.loads(r['coordenadas_json'])} for r in cursor.fetchall()]
    cursor.execute('SELECT matricula, nome FROM alunos WHERE usuario_id = ?', (usuario_id,))
    alunos_dict = {row['matricula']: row['nome'] for row in cursor.fetchall()}
    cursor.execute('SELECT aluno_matricula, bancada_nome FROM assentos WHERE materia_id = ? AND sala_id = ?', (aula['materia_id'], aula['sala_id']))
    assentos_aula = {row['aluno_matricula']: row['bancada_nome'] for row in cursor.fetchall()}
    conn.close()

    manager = Manager()
    shared_state = manager.dict({
        "faces": [],
        "fighting": False,
        "running": True
    })
    
    clip_queue = Queue()
    frame_queue = Queue(maxsize=1) 

    ia_process = Process(target=ia_process_worker, args=(
        shared_state, frame_queue, clip_queue,
        dict(aula), zonas, alunos_dict, assentos_aula, DB_PATH, DATA_SCREENSHOTS
    ))
    ia_process.daemon = True
    ia_process.start()

    loop_count = 0
    erros_tentativas = 0
    frame_buffer = deque(maxlen=20) 
    active_recordings = []

    try:
        while cap.running or erros_tentativas < 50:
            try:
                ret, frame = cap.read()
                if not ret or frame is None: 
                    erros_tentativas += 1
                    time.sleep(0.05)
                    continue
                
                erros_tentativas = 0
                
                try:
                    if frame_queue.full():
                        frame_queue.get_nowait() 
                    frame_queue.put_nowait(frame.copy())
                except:
                    pass

                last_known_faces = list(shared_state.get("faces", []))
                is_fighting_now_global = shared_state.get("fighting", False)

                while not clip_queue.empty():
                    try:
                        v_filename = clip_queue.get_nowait()
                        active_recordings.append({'frames': list(frame_buffer), 'remaining': 30, 'filename': v_filename})
                    except:
                        break

                for (top, right, bottom, left, nome_exibicao, bancada_atual, cor, status_tela) in last_known_faces:
                    cv2.rectangle(frame, (left, top), (right, bottom), cor, 2)
                    cv2.putText(frame, f"{nome_exibicao} ({status_tela})" if status_tela != "Focado" else nome_exibicao, (left, top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, cor, 2)

                for z in zonas:
                    pts = np.array(z['pontos'], np.int32)
                    cv2.polylines(frame, [pts], True, (255, 200, 0), 2) 
                    cv2.putText(frame, z['nome'], tuple(z['pontos'][0]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255,200,0), 2)

                if is_fighting_now_global:
                    cv2.putText(frame, "BRIGA DETECTADA!", (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 255), 4)

                frame_desenhado = frame.copy()
                frame_buffer.append(frame_desenhado)

                for rec in active_recordings[:]:
                    rec['frames'].append(frame_desenhado)
                    rec['remaining'] -= 1
                    if rec['remaining'] <= 0:
                        filepath = os.path.join(DATA_CLIPS, rec['filename'])
                        threading.Thread(target=save_clip, args=(list(rec['frames']), filepath)).start()
                        active_recordings.remove(rec)

                ret, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 55])
                yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
                
                loop_count += 1
                if loop_count >= 60:
                    loop_count = 0
                    c_chk = get_db(); cur_chk = c_chk.cursor()
                    cur_chk.execute('SELECT status FROM aulas WHERE id=?', (aula['id'],))
                    chk_row = cur_chk.fetchone(); c_chk.close()
                    if not chk_row or chk_row['status'] != 'EM_ANDAMENTO': break

            except Exception as loop_error:
                print(f"Ignorando falha isolada no frame principal: {loop_error}")
                continue 
                
    except Exception as fatal_e:
        print(f"Erro fatal na câmera: {fatal_e}") 
    finally:
        shared_state["running"] = False 
        try:
            ia_process.terminate()
            ia_process.join(timeout=1.0)
        except: pass
        cap.release()

@app.get("/video_feed")
def video_feed(token: str):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("email")
        conn = get_db(); cursor = conn.cursor()
        cursor.execute("SELECT id FROM usuarios WHERE email = ?", (email,))
        user = cursor.fetchone(); conn.close()
        
        if not user: return Response(status_code=401)
        return StreamingResponse(gerar_frames_camera(user['id']), media_type="multipart/x-mixed-replace; boundary=frame")
    except: 
        return Response(status_code=401)

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000)