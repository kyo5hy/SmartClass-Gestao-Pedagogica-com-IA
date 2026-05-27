import torch
from ultralytics import YOLO

# Registra a classe PoseModel como segura globalmente (PyTorch 2.6+)
try:
    from ultralytics.nn.tasks import PoseModel
    torch.serialization.add_safe_globals([PoseModel])
except Exception:
    pass

class PoseEngine:
    def __init__(self, model_path="yolov8n-pose.pt"):
        self.model = YOLO(model_path, task="pose")
        
    def analyze_frame(self, frame):
        results = self.model(frame, verbose=False, device="cpu")
        alerts = []
        return alerts, results