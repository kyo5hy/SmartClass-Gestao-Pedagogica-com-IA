# core/face_engine.py
import face_recognition
import os
import pickle
import cv2
import numpy as np

class FaceEngine:
    def __init__(self, data_path="data/faces", encodings_file="data/encodings.pickle"):
        self.data_path = data_path
        self.encodings_file = encodings_file
        self.known_encodings = []
        self.known_names = []
        os.makedirs(self.data_path, exist_ok=True)
        self.load_encodings()

    def load_encodings(self):
        if os.path.exists(self.encodings_file):
            try:
                with open(self.encodings_file, "rb") as f:
                    data = pickle.load(f)
                    self.known_encodings = data.get("encodings", [])
                    self.known_names = data.get("names", [])
            except Exception:
                self.generate_all_encodings()
        else:
            self.generate_all_encodings()

    def _resize_image_for_edge(self, image, max_size=800):
        """ Redimensiona imagens gigantes para evitar que o Raspberry Pi fique sem RAM """
        h, w = image.shape[:2]
        if max(h, w) > max_size:
            scale = max_size / max(h, w)
            return cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        return image

    def generate_all_encodings(self):
        temp_encodings = []
        temp_names = []
        
        print("⚙️ [FaceEngine] A processar rostos para a Base de Dados da IA...")
        
        for file_name in os.listdir(self.data_path):
            if file_name.lower().endswith((".jpg", ".png", ".jpeg")):
                try:
                    image_path = os.path.join(self.data_path, file_name)
                    
                    # Usa o OpenCV para ler e redimensionar a imagem de forma segura
                    cv_img = cv2.imread(image_path)
                    if cv_img is None:
                        continue
                        
                    cv_img = self._resize_image_for_edge(cv_img)
                    rgb_img = cv2.cvtColor(cv_img, cv2.COLOR_BGR2RGB)
                    
                    # Localiza o rosto na imagem redimensionada (modelo 'hog' é mais rápido em CPU)
                    face_locations = face_recognition.face_locations(rgb_img, model="hog")
                    
                    if face_locations:
                        # Extrai a assinatura 128-d (encoding)
                        encodings = face_recognition.face_encodings(rgb_img, face_locations)
                        if encodings:
                            temp_encodings.append(encodings[0])
                            temp_names.append(os.path.splitext(file_name)[0])
                    else:
                        print(f"⚠️ [AVISO] Nenhum rosto detetado na imagem ({file_name}). Tente uma foto mais clara.")
                        
                except Exception as e:
                    print(f"⚠️ [ERRO] Falha ao processar ({file_name}): {e}")
        
        self.known_encodings = temp_encodings
        self.known_names = temp_names
        
        try:
            with open(self.encodings_file, "wb") as f:
                pickle.dump({"encodings": self.known_encodings, "names": self.known_names}, f)
            print(f"✅ [FaceEngine] {len(self.known_names)} perfis carregados e gravados com sucesso!")
        except Exception as e:
            print(f"❌ [ERRO] Falha ao gravar encodings.pickle: {e}")