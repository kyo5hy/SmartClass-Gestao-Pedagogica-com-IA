// app.js
const currentHost = window.location.hostname || '127.0.0.1';
const API_NODE = `http://${currentHost}:3000`;
const API_PYTHON = `http://${currentHost}:8000`;
const EMPTY_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

let fotoBase64Global = ""; let streamWebcam = null; let chartInstance = null; let retencaoChartInstance = null; let globalSalas = [];
let lastAlertId = null; 
let globalAlunos = []; 

function showToast(msg, type="success") {
    const t = document.getElementById('toast-box');
    let icon = type === "success" ? "check-circle" : (type === "warning" ? "exclamation-triangle" : "times-circle");
    t.innerHTML = `<i class="fas fa-${icon}"></i> ${msg}`; t.className = `custom-toast show ${type}`;
    setTimeout(() => t.classList.remove('show'), 3500);
}
window.originalAlert = window.alert; window.alert = function(msg) { showToast(msg, "success"); };

function checkLoginState() {
    const token = localStorage.getItem('sc_token');
    if(token) {
        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('user-display-name').innerText = localStorage.getItem('sc_nome') || "Usuário";
        if(localStorage.getItem('sc_role') === 'admin') document.getElementById('menu-usuarios').style.display = 'flex';
        else document.getElementById('menu-usuarios').style.display = 'none';
        const savedTabMenu = localStorage.getItem('smartclass_tab') || 'tab-home';
        switchTab(savedTabMenu); loadData(); 
    } else document.getElementById('login-overlay').style.display = 'flex';
}

async function fazerLogin() {
    const email = document.getElementById('login-email').value.trim(); 
    const senha = document.getElementById('login-senha').value;
    try {
        const res = await fetch(`${API_NODE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({username: email, password: senha}) });
        if(res.ok) {
            const data = await res.json();
            localStorage.setItem('sc_token', data.access_token); localStorage.setItem('sc_role', data.role); localStorage.setItem('sc_nome', data.nome);
            window.location.reload(); 
        } else showToast("Email ou senha incorretos", "error");
    } catch (err) { showToast("Erro ao conectar.", "error"); }
}

function logout() { localStorage.removeItem('sc_token'); localStorage.removeItem('sc_role'); localStorage.removeItem('sc_nome'); window.location.reload(); }

async function apiFetch(endpoint, options = {}) {
    const token = localStorage.getItem('sc_token');
    const headers = { ...options.headers, 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(`${API_NODE}${endpoint}`, { ...options, headers });
    if (response.status === 401 || response.status === 403) {
        if(endpoint !== '/aula/status_alunos' && endpoint !== '/alertas') { showToast("Sessão expirada ou negada.", "error"); setTimeout(logout, 2000); }
        throw new Error("Não autorizado");
    }
    return response;
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
    const targetTab = document.getElementById(tabId); if(targetTab) targetTab.classList.add('active');
    document.querySelectorAll('.menu-item').forEach(m => { if(m.getAttribute('onclick') && m.getAttribute('onclick').includes(tabId)) m.classList.add('active'); });
    localStorage.setItem('smartclass_tab', tabId);
    if(tabId === 'tab-home') carregarAnalytics(); if(tabId === 'tab-usuarios') carregarUsuarios();
}

function abrirVideoAlerta(videoFile) {
    document.getElementById('alert-video-player').src = `${API_PYTHON}/play_clip/${videoFile}`;
    document.getElementById('modal-video').style.display = 'flex';
}

function fecharModalVideo() {
    document.getElementById('alert-video-player').src = EMPTY_PIXEL;
    document.getElementById('modal-video').style.display = 'none';
}

function abrirScreenshotAlerta(imageFile) {
    document.getElementById('alert-screenshot-viewer').src = `${API_NODE}/screenshots/${imageFile}`;
    document.getElementById('modal-screenshot').style.display = 'flex';
}

function fecharModalScreenshot() {
    document.getElementById('alert-screenshot-viewer').src = EMPTY_PIXEL;
    document.getElementById('modal-screenshot').style.display = 'none';
}

async function loadData() {
    try {
        let [resS, resT, resM, resA, resHist, resAlrt] = await Promise.all([ apiFetch(`/salas`).catch(()=>({json:()=>[]})), apiFetch(`/turmas`).catch(()=>({json:()=>[]})), apiFetch(`/materias`).catch(()=>({json:()=>[]})), apiFetch(`/alunos`).catch(()=>({json:()=>[]})), apiFetch(`/aulas/historico`).catch(()=>({json:()=>[]})), apiFetch(`/alertas`).catch(()=>({json:()=>[]})) ]);
        let salas = await resS.json(), turmas = await resT.json(), materias = await resM.json(), historico = await resHist.json(), alertas = await resAlrt.json();
        
        globalSalas = salas;
        globalAlunos = await resA.json(); 

        let optsFiltro = `<option value="todas">Todas as Turmas</option>` + turmas.map(t => `<option value="${t.nome}">${t.nome}</option>`).join('');
        document.getElementById('filtro-turma-aluno').innerHTML = optsFiltro;
        filtrarAlunos(); 

        document.getElementById('tabela-salas').innerHTML = `<table><tr><th>Ambiente</th><th>Câmera</th><th style="width:100px; text-align:center">Ações</th></tr>` + salas.map(s => `<tr><td><b>${s.nome}</b></td><td style="color:var(--text-muted)">${s.camera_url}</td><td class="flex-row" style="justify-content:center"><button class="btn-outline" style="padding:6px 12px" onclick="abrirModalMapa(${s.id})" title="Calibrar Zonas"><i class="fas fa-crop-alt"></i></button><button class="btn-outline" style="padding:6px 12px; color:var(--if-red)" onclick="delSala(${s.id})"><i class="fas fa-trash"></i></button></td></tr>`).join('') + `</table>`;
        document.getElementById('tabela-materias').innerHTML = `<table><tr><th>Disciplina Importada</th><th>Turma Alvo</th><th style="width:70px">Ação</th></tr>` + materias.map(m => `<tr><td><b>${m.nome}</b></td><td>${m.turma_nome}</td><td><button class="btn-outline" style="padding:6px 12px; color:var(--if-red)" onclick="delMateria(${m.id})"><i class="fas fa-trash"></i></button></td></tr>`).join('') + `</table>`;
        document.getElementById('tabela-historico').innerHTML = `<table><tr><th>Data</th><th>Aula</th><th>Duração</th><th style="width:200px">Ações</th></tr>` + historico.map(h => { let styleRow = h.status === "FINALIZADA" ? "color: var(--text-muted)" : "color: var(--if-green); font-weight: 600"; return `<tr><td style="${styleRow}">${h.data_dia}</td><td style="${styleRow}"><b>${h.materia_nome}</b><br><span style="font-size:0.85em; font-weight:normal">${h.turma_nome}</span></td><td style="${styleRow}">${h.hora_inicio} ➔ ${h.hora_fim || "..."}</td><td class="flex-row"><button class="btn-outline" style="padding:8px; border-color:var(--if-green); color:var(--if-green)" onclick="baixarExcel(${h.id})"><i class="fas fa-file-excel"></i></button><button class="btn-outline" style="padding:8px 12px; font-size:0.85em;" onclick="abrirJustificativa(${h.id})"> Abonar Falta</button></td></tr>`; }).join('') + `</table>`;
        
        document.getElementById('tabela-alertas').innerHTML = `<table><tr><th>Data e Hora</th><th>Contexto</th><th>Ocorrência</th></tr>` + alertas.map(a => { 
            let icon = "fa-bell"; let color = "var(--warning)"; 
            if(a.mensagem.includes("CELULAR") || a.mensagem.includes("BRIGA") || a.mensagem.includes("EVASÃO")) { color = "var(--if-red)"; icon = "fa-exclamation-triangle"; } 
            
            let btnVideo = a.video_file ? `<button class="btn-outline" style="margin-top: 5px; padding: 4px 8px; font-size: 0.85em; border-color: var(--primary); color: var(--primary);" onclick="abrirVideoAlerta('${a.video_file}')"><i class="fas fa-video"></i> Vídeo</button>` : "";
            let btnImage = a.image_file ? `<button class="btn-outline" style="margin-top: 5px; margin-left: 5px; padding: 4px 8px; font-size: 0.85em; border-color: var(--if-green); color: var(--if-green);" onclick="abrirScreenshotAlerta('${a.image_file}')"><i class="fas fa-camera"></i> Foto</button>` : "";
            
            return `<tr><td style="color:var(--text-muted); white-space:nowrap">${a.data_hora}</td><td>${a.sala_nome} <br><span style="font-size:0.8em">${a.materia_nome}</span></td><td style="color:${color}; font-weight:500"><i class="fas ${icon}"></i> ${a.mensagem} <br>${btnVideo}${btnImage}</td></tr>`; 
        }).join('') + `</table>`;

        let optsMaterias = materias.length > 0 ? materias.map(m => `<option value="${m.id}">${m.nome} (${m.turma_nome})</option>`).join('') : "<option value=''>Nenhuma matéria...</option>";
        document.getElementById('sel-materia-assento').innerHTML = optsMaterias;
        let optsSalas = salas.length > 0 ? salas.map(s => `<option value="${s.id}">${s.nome}</option>`).join('') : "<option value=''>Nenhum ambiente...</option>";
        document.getElementById('sel-sala-assento').innerHTML = optsSalas;
        
        await checkAula(materias, salas); 
        try { if(materias.length > 0 && salas.length > 0) await carregarEditorAssentos(); } catch (e) {}
    } catch (e) {}
}

function filtrarAlunos() {
    const turmaSelecionada = document.getElementById('filtro-turma-aluno').value;
    let filtrados = globalAlunos;

    if (turmaSelecionada && turmaSelecionada !== "todas") {
        filtrados = globalAlunos.filter(a => a.turma_nome === turmaSelecionada);
    }

    document.getElementById('tabela-alunos').innerHTML = `<table>
        <tr><th>Matrícula</th><th>Aluno</th><th>Turma</th><th style="text-align:center">Biometria</th><th style="width:70px">Ação</th></tr>` + 
        filtrados.map(a => `<tr>
            <td style="color:var(--text-muted)">${a.matricula}</td>
            <td><b>${a.nome}</b></td>
            <td>${a.turma_nome}</td>
            <td style="text-align:center">
                <button class="btn-outline" style="padding:6px 12px; font-size:0.85em; border-color:var(--if-green); color:var(--if-green)" onclick="abrirModalFoto('${a.matricula}', '${a.nome}')" title="Atualizar Biometria">
                    <i class="fas fa-camera"></i> / <i class="fas fa-upload"></i> Capturar
                </button>
            </td>
            <td>
                <button class="btn-outline" style="padding:6px 12px; color:var(--if-red)" onclick="delAluno('${a.matricula}')" title="Excluir Aluno"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`).join('') + `</table>`;
}

async function carregarUsuarios() { let res = await apiFetch(`/usuarios`).catch(()=>null); if(!res) return; let usuarios = await res.json(); document.getElementById('tabela-usuarios-admin').innerHTML = `<table><tr><th>ID</th><th>Nome</th><th>Email</th><th>Role</th><th>Ação</th></tr>` + usuarios.map(u => `<tr><td>#${u.id}</td><td><b>${u.nome}</b></td><td>${u.email}</td><td><span style="background:var(--bg-hover); padding:3px 8px; border-radius:5px;">${u.role}</span></td><td><button class="btn-red" style="padding:6px 10px" onclick="delUsuario(${u.id})"><i class="fas fa-trash"></i></button></td></tr>`).join('') + `</table>`; }
async function salvarUsuario() { let nome = document.getElementById('cad-user-nome').value; let email = document.getElementById('cad-user-email').value.trim(); let senha = document.getElementById('cad-user-senha').value; let role = document.getElementById('cad-user-role').value; if(!nome || !email || !senha) return showToast("Preencha todos os campos", "warning"); let res = await apiFetch(`/usuarios`, { method: 'POST', body: JSON.stringify({nome, email, senha, role})}).catch(()=>null); if(res && res.ok) { showToast("Usuário criado!"); carregarUsuarios(); } else showToast("Erro. Email pode já existir.", "error"); }
async function delUsuario(id) { if(confirm("Apagar conta?")) { let res = await apiFetch(`/usuarios/${id}`, { method: 'DELETE' }).catch(()=>null); if(res && res.ok) { showToast("Usuário removido"); carregarUsuarios(); } } }

async function addSala() { const nome = document.getElementById('in-sala').value.trim(); const url = document.getElementById('in-cam').value.trim(); if(!nome || !url) return showToast("Preencha o Nome e a Câmera", "warning"); await apiFetch(`/salas`, { method: 'POST', body: JSON.stringify({nome: nome, camera_url: url})}); document.getElementById('in-sala').value = ""; document.getElementById('in-cam').value = ""; loadData(); showToast("Ambiente Registrado."); }
async function delSala(id) { if(confirm("Apagar sala?")) { await apiFetch(`/salas/${id}`, { method: 'DELETE' }); loadData(); } }
async function delMateria(id) { if(confirm("Apagar disciplina? Isso removerá as configurações vinculadas.")) { await apiFetch(`/materias/${id}`, { method: 'DELETE' }); loadData(); } }
async function delAluno(mat) { if(confirm("Apagar permanentemente o aluno?")) { await apiFetch(`/alunos/${mat}`, { method: 'DELETE' }); showToast("Aluno descadastrado."); loadData(); } }

function abrirModalFoto(matricula, nome) {
    document.getElementById('foto-aluno-mat').value = matricula;
    document.getElementById('foto-aluno-nome').innerText = nome;
    document.getElementById('img-preview').style.display = 'none';
    document.getElementById('cam-box').style.display = 'none';
    fotoBase64Global = "";
    document.getElementById('modal-foto').style.display = 'flex';
}

function fecharModalFoto() {
    document.getElementById('modal-foto').style.display = 'none';
    fecharWebcam();
}

async function abrirWebcam() { try { streamWebcam = await navigator.mediaDevices.getUserMedia({ video: true }); document.getElementById('webcam-preview').srcObject = streamWebcam; document.getElementById('cam-box').style.display = 'block'; document.getElementById('img-preview').style.display = 'none'; } catch (err) { showToast("Erro de permissão da webcam.", "error"); } }
function fecharWebcam() { if(streamWebcam) streamWebcam.getTracks().forEach(t => t.stop()); document.getElementById('cam-box').style.display = 'none'; }
function handleFileUpload(event) { const file = event.target.files[0]; const reader = new FileReader(); reader.onload = function(e) { fotoBase64Global = e.target.result; document.getElementById('img-preview').src = fotoBase64Global; document.getElementById('img-preview').style.display = 'block'; fecharWebcam(); }; reader.readAsDataURL(file); }

async function salvarFotoAluno() {
    const mat = document.getElementById('foto-aluno-mat').value;
    
    if(document.getElementById('cam-box').style.display === 'block') { 
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480; 
        canvas.getContext('2d').drawImage(document.getElementById('webcam-preview'), 0, 0, 640, 480); 
        fotoBase64Global = canvas.toDataURL('image/jpeg'); 
        fecharWebcam(); 
    }
    
    if(!fotoBase64Global) return showToast("Capture ou importe uma foto primeiro.", "warning");
    
    let res = await apiFetch(`/alunos/${mat}/foto`, { method: 'POST', body: JSON.stringify({foto_base64: fotoBase64Global})});
    if(res.ok) { 
        showToast("Biometria atualizada com sucesso!"); 
        fecharModalFoto();
    } else {
        showToast("Erro ao salvar a foto na API.", "error");
    }
}

async function processarExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            showToast("Analisando planilha SIGAA...", "success");
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type: 'array'});
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(worksheet, {header: 1, defval: ""});

            let materiaNome = "Matéria Importada";
            let turmaNome = "Turma Importada";
            let anoSemestre = "2026.1";

            if (json.length >= 3) {
                let linha3 = json[2].join(" ");
                let matMatch = linha3.match(/-\s*(.*?)\s*\(\d+h\)/i) || linha3.match(/-\s*(.*?)\s*\(/);
                if (matMatch) materiaNome = matMatch[1].trim();
                let turmaMatch = linha3.match(/Turma:\s*([\w\d]+)/i);
                if (turmaMatch) turmaNome = "Turma " + turmaMatch[1].trim();
                let anoMatch = linha3.match(/\((20\d{2}\.\d)\)/);
                if (anoMatch) anoSemestre = anoMatch[1].trim();
            }

            let resT = await apiFetch(`/turmas`);
            let turmas = await resT.json();
            let turmaEncontrada = turmas.find(t => t.nome === turmaNome);
            let turmaId;

            if (turmaEncontrada) {
                turmaId = turmaEncontrada.id;
            } else {
                await apiFetch(`/turmas`, { method: 'POST', body: JSON.stringify({nome: turmaNome, periodo: "Geral", ano_semestre: anoSemestre})});
                resT = await apiFetch(`/turmas`);
                turmas = await resT.json();
                turmaId = turmas.find(t => t.nome === turmaNome).id;
            }

            let resM = await apiFetch(`/materias`);
            let materias = await resM.json();
            let materiaEncontrada = materias.find(m => m.nome === materiaNome && m.turma_nome === turmaNome);
            
            if (!materiaEncontrada) {
                await apiFetch(`/materias`, { method: 'POST', body: JSON.stringify({nome: materiaNome, turma_id: turmaId})});
            }

            let alunosImportados = 0;
            for (let i = 12; i < json.length; i++) {
                let row = json[i].filter(cell => cell !== "");
                if (row.length >= 2) {
                    let matricula = String(row[0]).trim();
                    if (matricula.endsWith(".0")) matricula = matricula.slice(0, -2);
                    let nome = String(row[1]).trim();
                    
                    if (matricula && nome) {
                        await apiFetch(`/alunos`, { 
                            method: 'POST', 
                            body: JSON.stringify({
                                nome: nome, 
                                matricula: matricula, 
                                turma_id: turmaId, 
                                foto_base64: "" 
                            }) 
                        });
                        alunosImportados++;
                    }
                }
            }

            showToast(`Pronto! ${alunosImportados} alunos inseridos na ${materiaNome}.`, "success");
            loadData(); 
            document.getElementById('excel-upload').value = ""; 

        } catch (err) {
            console.error("Erro na leitura do arquivo Excel:", err);
            showToast("Ocorreu uma falha ao interpretar a planilha.", "error");
        }
    };
    reader.readAsArrayBuffer(file);
}

async function baixarExcel(aulaId) { 
    const url = aulaId === 'last' ? `/aula/last/relatorio` : `/aula/${aulaId}/relatorio`; 
    try {
        const response = await apiFetch(url); 
        if (response.ok) {
            const blob = await response.blob(); 
            const downloadUrl = window.URL.createObjectURL(blob); 
            const a = document.createElement('a'); 
            a.href = downloadUrl; 
            a.download = `DiarioClasse.xlsx`; 
            document.body.appendChild(a); 
            a.click(); 
            a.remove(); 
        } else {
            const errorText = await response.text();
            showToast(`Erro do Sistema: ${errorText}`, "error");
        }
    } catch(e) {
        showToast("Falha na conexão ao tentar gerar a planilha.", "error");
    }
}

async function carregarAnalytics() {
    let [resA, resR] = await Promise.all([ apiFetch(`/analytics`).catch(()=>null), apiFetch(`/analytics/retencao`).catch(()=>null) ]);
    
    if(resA) { 
        let data = await resA.json(); 
        document.getElementById('lbl-total-alunos').innerText = data.total_alunos; 
        document.getElementById('lbl-total-aulas').innerText = data.total_aulas; 
        document.getElementById('lbl-total-alertas').innerText = data.total_alertas; 
        
        if(chartInstance) chartInstance.destroy(); 
        
        chartInstance = new Chart(document.getElementById('chart-frequencia').getContext('2d'), { 
            type: 'bar', 
            data: { 
                labels: data.frequencia_turmas.map(t => t.nome), 
                datasets: [
                    { 
                        label: 'Matriculados', 
                        data: data.frequencia_turmas.map(t => t.matriculados), 
                        backgroundColor: '#2563eb', borderRadius: 4 
                    },
                    { 
                        label: 'Presenças Registradas', 
                        data: data.frequencia_turmas.map(t => t.presencas), 
                        backgroundColor: '#7AC142', borderRadius: 4 
                    }
                ] 
            }, 
            options: { 
                responsive: true, maintainAspectRatio: false, 
                plugins: { legend: { display: true, position: 'top' } }, 
                scales: { y: { beginAtZero: true, grid: { color: '#e2e8f0' } }, x: { grid: { display: false } } } 
            } 
        }); 
    }

    if(resR) { 
        let dataRet = await resR.json(); 
        if(retencaoChartInstance) retencaoChartInstance.destroy(); 
        
        const ctxRet = document.getElementById('chart-retencao').getContext('2d'); 
        Chart.defaults.color = '#64748b'; 
        
        retencaoChartInstance = new Chart(ctxRet, { 
            type: 'doughnut', 
            data: { 
                labels: dataRet.labels, 
                datasets: [{ 
                    data: dataRet.data, 
                    backgroundColor: ['#7AC142', '#E30613', '#f59e0b'], 
                    borderWidth: 2, 
                    borderColor: '#ffffff',
                    hoverOffset: 4
                }] 
            }, 
            options: { 
                responsive: true, 
                maintainAspectRatio: false, 
                cutout: '65%', 
                plugins: { 
                    legend: { 
                        display: true, 
                        position: 'right', 
                        labels: { color: '#0f172a', font: {family: 'Inter', size: 12} } 
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) { return ' ' + context.label + ': ' + context.parsed + '%'; }
                        }
                    }
                } 
            } 
        }); 
    }
}

async function abrirJustificativa(aula_id) { const matricula = prompt("Digite a Matrícula do aluno:"); if(!matricula) return; const motivo = prompt("Motivo da justificativa:"); if(!motivo) return; let res = await apiFetch(`/justificar`, { method: 'POST', body: JSON.stringify({aula_id: aula_id, aluno_matricula: matricula, motivo: motivo}) }); if(res.ok) { showToast("Justificativa registrada.", "success"); loadData(); } }

async function carregarEditorAssentos() {
    const matId = document.getElementById('sel-materia-assento').value; const salaId = document.getElementById('sel-sala-assento').value; if(!matId || !salaId) return;
    let [resA, resZ, resAss] = await Promise.all([ apiFetch(`/materias/${matId}/alunos`), apiFetch(`/salas/${salaId}/zonas`), apiFetch(`/assentos/${matId}/${salaId}`) ]);
    let alunosTemp = await resA.json(), zonasTemp = await resZ.json(), assentosSalvos = await resAss.json();
    const container = document.getElementById('lista-assentos');
    if(zonasTemp.length === 0) { container.innerHTML = `<span style="color:var(--warning)"><i class="fas fa-exclamation-triangle"></i> Sem bancadas. Vá em Infraestrutura.</span>`; return; }
    let opts = `<option value="">-- Assento Livre --</option>` + alunosTemp.map(a => `<option value="${a.matricula}">${a.nome}</option>`).join(''); let html = '';
    zonasTemp.forEach(z => { html += `<div class="seat-row" data-bancada="${z.nome_bancada}"><b style="width: 35%">${z.nome_bancada}</b> 👉 <select class="sel-aluno-bancada">${opts}</select></div>`; });
    container.innerHTML = html;
    container.querySelectorAll('.seat-row').forEach(row => { let salvo = assentosSalvos.find(ast => ast.bancada_nome === row.getAttribute('data-bancada')); if(salvo) row.querySelector('select').value = salvo.aluno_matricula; });
}

async function salvarAssentos() { 
    const matId = parseInt(document.getElementById('sel-materia-assento').value); 
    const salaId = document.getElementById('sel-sala-assento').value; 
    let assentos = []; 
    document.querySelectorAll('#lista-assentos .seat-row').forEach(row => { 
        let mat = row.querySelector('select').value; 
        if(mat) assentos.push({ aluno_matricula: mat, bancada_nome: row.getAttribute('data-bancada') }); 
    }); 
    await apiFetch(`/assentos`, { method: 'POST', body: JSON.stringify({ materia_id: matId, sala_id: salaId, assentos: assentos }) }); 
    showToast("Layout salvo!", "success"); 
}

function atualizarPreviewCamera() {
    const salaId = document.getElementById('start-sala').value; 
    const sala = globalSalas.find(s => s.id == salaId); 
    const videoEl = document.getElementById('live-video');
    if(sala && !(/^\d+$/.test(sala.camera_url))) { videoEl.src = `${API_PYTHON}/map_feed/${sala.id}?token=${localStorage.getItem('sc_token')}`; } else { videoEl.src = EMPTY_PIXEL; }
}

async function checkAula(materias, salas) {
    let res = await apiFetch(`/aula/status`); let aula = await res.json(); let barra = document.getElementById('barra-controle');
    if (aula) {
        barra.innerHTML = `<div style="flex:1; font-size:1.15em">🟢 <b style="color:var(--text-main)">${aula.materia_nome}</b> (Sala: ${aula.sala_nome})</div><button class="btn-outline" style="width:auto; margin-right:15px; border-color:var(--if-green); color:var(--if-green)" onclick="baixarExcel('last')"><i class="fas fa-file-excel"></i> Relatório Atual</button><button class="btn-red" style="width:160px" onclick="encerrarAula()"><i class="fas fa-stop"></i> Encerrar Aula</button>`;
        document.getElementById('live-video').src = `${API_PYTHON}/video_feed?token=${localStorage.getItem('sc_token')}`;
    } else {
        let optsM = materias ? materias.map(m => `<option value="${m.id}">${m.nome} (${m.turma_nome})</option>`).join('') : ""; let optsS = salas ? salas.map(s => `<option value="${s.id}">${s.nome}</option>`).join('') : "";
        barra.innerHTML = `<select id="start-mat" style="flex:1">${optsM}</select><select id="start-sala" style="flex:1" onchange="atualizarPreviewCamera()">${optsS}</select><button class="btn-blue" style="width:280px; font-size:1.05em" onclick="iniciarAula()"><i class="fas fa-play-circle"></i> Iniciar Aula Virtual</button>`;
        atualizarPreviewCamera();
    }
}
async function iniciarAula() { const btn = event.currentTarget; if(btn) { btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Conectando...`; btn.disabled = true; } document.getElementById('live-video').src = EMPTY_PIXEL; await new Promise(r => setTimeout(r, 1000)); await apiFetch(`/aula/iniciar`, { method: 'POST', body: JSON.stringify({ materia_id: parseInt(document.getElementById('start-mat').value), sala_id: parseInt(document.getElementById('start-sala').value) }) }); loadData(); showToast("Aula Iniciada! IA Ativada.", "success"); }
async function encerrarAula() { const btn = event.currentTarget; if(btn) { btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Encerrando...`; btn.disabled = true; } document.getElementById('live-video').src = EMPTY_PIXEL; await apiFetch(`/aula/encerrar`, { method: 'POST' }); await new Promise(r => setTimeout(r, 1000)); loadData(); showToast("Aula Encerrada e Diário salvo.", "warning"); }

setInterval(async () => {
    if(!localStorage.getItem('sc_token')) return; 
    const res = await apiFetch(`/aula/status_alunos`).catch(()=>null); 
    if(res) {
        const alunos = await res.json();
        if(alunos.length > 0) {
            document.getElementById('lista-alunos').innerHTML = alunos.map(a => {
                let classe = ""; let textoLugar = "";
                
                if(a.status_atencao === "USANDO CELULAR") { 
                    classe = "celular"; 
                    textoLugar = `<i class="fas fa-mobile-alt"></i> Uso de Smartphone detectado!`; 
                } 
                else if (a.bancada_atual === "Área Livre") { 
                    classe = "fora"; 
                    textoLugar = `<i class="fas fa-walking"></i> Disperso (Circulando pela sala)`; 
                } 
                else if(a.bancada_fixa && a.bancada_atual !== a.bancada_fixa) { 
                    classe = "errada"; 
                    textoLugar = `<i class="fas fa-exchange-alt"></i> Bancada Incorreta (Está na ${a.bancada_atual})`; 
                } 
                else if(a.status_atencao === "DISTRAÍDO") { 
                    classe = "distraido"; 
                    textoLugar = `<i class="fas fa-eye-slash"></i> Distraído na bancada`; 
                } 
                else { 
                    classe = "focado";
                    textoLugar = `<i class="fas fa-check-circle"></i> Focado em: ${a.bancada_atual}`; 
                }
                
                return `<div class="student-item ${classe}"><b>${a.aluno_nome}</b><span>${textoLugar}</span></div>`;
            }).join('');
        } else document.getElementById('lista-alunos').innerHTML = "<span style='color:var(--text-muted); font-size:0.9em'>Aguardando IA...</span>";
    }

    const resAlertas = await apiFetch(`/alertas`).catch(()=>null);
    if(resAlertas) {
        const alertas = await resAlertas.json();
        if(alertas.length > 0) {
            const highestId = alertas[0].id; 
            if (lastAlertId !== null && highestId > lastAlertId) {
                const newAlerts = alertas.filter(a => a.id > lastAlertId);
                newAlerts.forEach(na => {
                    let type = "warning";
                    if(na.mensagem.includes("BRIGA") || na.mensagem.includes("CELULAR") || na.mensagem.includes("EVASÃO")) {
                        type = "error";
                        let audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
                        audio.volume = 0.5;
                        audio.play().catch(e => console.log("Áudio bloqueado pelo navegador", e));
                    }
                    showToast(na.mensagem, type); 
                });
            }
            lastAlertId = highestId; 
        }
    }
}, 2000);

let salaMapeando = 0; let zonas = []; let currentPolygon = []; let mouseX = 0, mouseY = 0; const canvas = document.getElementById('map-canvas'); const ctx = canvas.getContext('2d');
function abrirModalMapa(sala_id) { salaMapeando = sala_id; zonas = []; currentPolygon = []; document.getElementById('modal-mapa').style.display = 'flex'; document.getElementById('map-img').src = `${API_PYTHON}/map_feed/${sala_id}?token=${localStorage.getItem('sc_token')}`; desenhar(); }
function fecharModalMapa() { document.getElementById('modal-mapa').style.display = 'none'; document.getElementById('map-img').src = EMPTY_PIXEL; currentPolygon = []; }
canvas.addEventListener('mousemove', function(e) { const rect = canvas.getBoundingClientRect(); mouseX = Math.round(e.clientX - rect.left); mouseY = Math.round(e.clientY - rect.top); desenhar(); });
canvas.addEventListener('mousedown', function(e) { if(e.button !== 0) return; const rect = canvas.getBoundingClientRect(); const x = Math.round(e.clientX - rect.left); const y = Math.round(e.clientY - rect.top); if (currentPolygon.length > 2) { const firstPt = currentPolygon[0]; const dist = Math.hypot(x - firstPt[0], y - firstPt[1]); if (dist < 15) { fecharPoligono(); return; } } currentPolygon.push([x, y]); desenhar(); });
canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); if (currentPolygon.length > 0) { currentPolygon.pop(); desenhar(); } });
function fecharPoligono() { if (currentPolygon.length < 3) return; const nome = prompt("Defina o nome da bancada:"); if (nome) zonas.push({nome_bancada: nome, coordenadas: [...currentPolygon]}); currentPolygon = []; desenhar(); }
function limparCanvas() { zonas = []; currentPolygon = []; desenhar(); }
function desenhar() { ctx.clearRect(0, 0, canvas.width, canvas.height); zonas.forEach(z => { ctx.beginPath(); ctx.strokeStyle = "#7AC142"; ctx.lineWidth = 2; z.coordenadas.forEach((pt, i) => i === 0 ? ctx.moveTo(pt[0], pt[1]) : ctx.lineTo(pt[0], pt[1])); ctx.closePath(); ctx.stroke(); ctx.fillStyle = "rgba(122, 193, 66, 0.15)"; ctx.fill(); ctx.fillStyle = "#7AC142"; ctx.font = "bold 15px Arial"; ctx.fillText(z.nome_bancada, z.coordenadas[0][0] + 5, z.coordenadas[0][1] + 20); }); if (currentPolygon.length > 0) { ctx.beginPath(); ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2; ctx.moveTo(currentPolygon[0][0], currentPolygon[0][1]); for (let i = 1; i < currentPolygon.length; i++) ctx.lineTo(currentPolygon[i][0], currentPolygon[i][1]); ctx.lineTo(mouseX, mouseY); ctx.stroke(); currentPolygon.forEach((pt, i) => { ctx.beginPath(); ctx.arc(pt[0], pt[1], i === 0 ? 6 : 4, 0, Math.PI * 2); ctx.fillStyle = i === 0 ? "#E30613" : "#2563eb"; ctx.fill(); }); } }
async function salvarMapa() { await apiFetch(`/salas/${salaMapeando}/zonas`, { method: 'POST', body: JSON.stringify({zonas: zonas}) }); showToast("Calibração salva na Nuvem."); fecharModalMapa(); }

function toggleFullScreen() {
    const videoContainer = document.getElementById('video-container');
    if (!document.fullscreenElement) {
        if (videoContainer.requestFullscreen) { videoContainer.requestFullscreen(); }
        else if (videoContainer.webkitRequestFullscreen) { videoContainer.webkitRequestFullscreen(); } 
        else if (videoContainer.msRequestFullscreen) { videoContainer.msRequestFullscreen(); } 
    } else {
        if (document.exitFullscreen) { document.exitFullscreen(); }
    }
}

window.onload = () => { 
    if (localStorage.getItem('sc_token') && !JSON.parse(atob(localStorage.getItem('sc_token').split('.')[1])).email) {
        logout();
    } else {
        setTimeout(checkLoginState, 100); 
    }
};