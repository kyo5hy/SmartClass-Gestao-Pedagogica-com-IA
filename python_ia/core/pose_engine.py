from ultralytics import YOLO

class PoseEngine:
    def __init__(self, model_path="yolov8n-pose.pt"):
        # Carrega o modelo de esqueleto (Pose)
        self.model = YOLO(model_path)
        
    def analyze_frame(self, frame):
        # Roda o modelo invisivelmente
        results = self.model(frame, verbose=False)
        alerts = []
        
        # O sistema de agressão e postura (cabeça baixa) agora é tratado
        # dinamicamente pelo arquivo aulas.py usando esses resultados!
        
        return alerts, results