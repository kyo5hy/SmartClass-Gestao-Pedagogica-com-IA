// server.js
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); 
const ExcelJS = require('exceljs');

// Carrega as variáveis do .env localizado na raiz do projeto
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { runQuery, getQuery, allQuery } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); 

// Criando e Liberando diretório Público para os Clipes e Screenshots
const clipsPath = path.resolve(__dirname, '../data/clips');
if (!fs.existsSync(clipsPath)) fs.mkdirSync(clipsPath, { recursive: true });
app.use('/clips', express.static(clipsPath));

const screenshotsPath = path.resolve(__dirname, '../data/screenshots');
if (!fs.existsSync(screenshotsPath)) fs.mkdirSync(screenshotsPath, { recursive: true });
app.use('/screenshots', express.static(screenshotsPath));

// Consumindo a chave do ambiente de forma segura
const SECRET_KEY = process.env.SECRET_KEY;
if (!SECRET_KEY) {
    console.error("❌ ERRO FATAL: SECRET_KEY não definida no arquivo .env");
    process.exit(1);
}

const authMiddleware = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "Token não fornecido" });
        const decoded = jwt.verify(token, SECRET_KEY);
        const user = await getQuery("SELECT * FROM usuarios WHERE id = ?", [decoded.id]);
        if (!user) return res.status(401).json({ error: "Usuário inválido" });
        req.user = user;
        next();
    } catch (e) { res.status(401).json({ error: "Sessão inválida" }); }
};

const adminMiddleware = (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: "Acesso negado" });
    next();
};

app.post("/token", async (req, res) => {
    const { username, password } = req.body;
    const user = await getQuery("SELECT * FROM usuarios WHERE email = ?", [username.trim()]);
    if (!user || !bcrypt.compareSync(password, user.senha_hash)) return res.status(401).json({ error: "Credenciais inválidas" });
    const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { expiresIn: '24h' });
    res.json({ access_token: token, role: user.role, nome: user.nome });
});

app.get("/usuarios", authMiddleware, adminMiddleware, async (req, res) => res.json(await allQuery("SELECT id, email, nome, role FROM usuarios")));
app.post("/usuarios", authMiddleware, adminMiddleware, async (req, res) => {
    try { await runQuery("INSERT INTO usuarios (email, senha_hash, nome, role) VALUES (?, ?, ?, ?)", [req.body.email.trim(), bcrypt.hashSync(req.body.senha, 10), req.body.nome, req.body.role]); res.json({ status: "ok" }); } 
    catch (e) { res.status(400).json({ error: "Email já existe" }); }
});
app.delete("/usuarios/:id", authMiddleware, adminMiddleware, async (req, res) => {
    if (req.user.id == req.params.id) return res.status(400).json({ error: "Não pode se excluir" });
    await runQuery("DELETE FROM usuarios WHERE id = ?", [req.params.id]); res.json({ status: "ok" });
});

app.get("/salas", authMiddleware, async (req, res) => res.json(await allQuery("SELECT * FROM salas")));
app.post("/salas", authMiddleware, async (req, res) => { await runQuery("INSERT INTO salas (nome, camera_url) VALUES (?, ?)", [req.body.nome.trim(), req.body.camera_url.trim()]); res.json({ status: "ok" }); });
app.delete("/salas/:id", authMiddleware, async (req, res) => { await runQuery("DELETE FROM zonas_sala WHERE sala_id=?", [req.params.id]); await runQuery("DELETE FROM salas WHERE id=?", [req.params.id]); res.json({ status: "ok" }); });
app.get("/salas/:id/zonas", authMiddleware, async (req, res) => {
    const zonas = await allQuery("SELECT nome_bancada, coordenadas_json FROM zonas_sala WHERE sala_id = ?", [req.params.id]);
    res.json(zonas.map(z => ({ nome_bancada: z.nome_bancada, coordenadas: JSON.parse(z.coordenadas_json) })));
});
app.post("/salas/:id/zonas", authMiddleware, async (req, res) => {
    await runQuery("DELETE FROM zonas_sala WHERE sala_id = ?", [req.params.id]);
    for (let z of req.body.zonas) await runQuery("INSERT INTO zonas_sala (sala_id, nome_bancada, coordenadas_json) VALUES (?, ?, ?)", [req.params.id, z.nome_bancada, JSON.stringify(z.coordenadas)]);
    res.json({ status: "ok" });
});

app.get("/turmas", authMiddleware, async (req, res) => res.json(await allQuery("SELECT * FROM turmas WHERE usuario_id = ?", [req.user.id])));
app.post("/turmas", authMiddleware, async (req, res) => { await runQuery("INSERT INTO turmas (nome, periodo, ano_semestre, usuario_id) VALUES (?, ?, ?, ?)", [req.body.nome.trim(), req.body.periodo, req.body.ano_semestre, req.user.id]); res.json({ status: "ok" }); });
app.delete("/turmas/:id", authMiddleware, async (req, res) => { await runQuery("DELETE FROM turmas WHERE id=? AND usuario_id=?", [req.params.id, req.user.id]); res.json({ status: "ok" }); });

app.get("/materias", authMiddleware, async (req, res) => res.json(await allQuery("SELECT m.id, m.nome, t.nome as turma_nome FROM materias m JOIN turmas t ON m.turma_id = t.id WHERE m.usuario_id = ?", [req.user.id])));
app.post("/materias", authMiddleware, async (req, res) => { await runQuery("INSERT INTO materias (nome, turma_id, usuario_id) VALUES (?, ?, ?)", [req.body.nome.trim(), req.body.turma_id, req.user.id]); res.json({ status: "ok" }); });
app.delete("/materias/:id", authMiddleware, async (req, res) => { await runQuery("DELETE FROM materias WHERE id=? AND usuario_id=?", [req.params.id, req.user.id]); res.json({ status: "ok" }); });

app.get("/alunos", authMiddleware, async (req, res) => res.json(await allQuery("SELECT a.matricula, a.nome, t.nome as turma_nome FROM alunos a JOIN turmas t ON a.turma_id = t.id WHERE a.usuario_id = ?", [req.user.id])));

app.post("/alunos", authMiddleware, async (req, res) => {
    try {
        await runQuery("INSERT OR REPLACE INTO alunos (matricula, nome, turma_id, usuario_id) VALUES (?, ?, ?, ?)", [req.body.matricula.trim(), req.body.nome.trim(), req.body.turma_id, req.user.id]);
        if (req.body.foto_base64 && req.body.foto_base64.trim() !== "") {
            const base64Data = req.body.foto_base64.replace(/^data:image\/\w+;base64,/, "");
            fs.writeFileSync(path.resolve(__dirname, `../data/faces/${req.body.matricula.trim()}.jpg`), base64Data, 'base64');
            try { await axios.post('http://127.0.0.1:8000/api/reload_faces'); } catch(e) {} 
        }
        res.json({ status: "ok" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/alunos/:id/foto", authMiddleware, async (req, res) => {
    try {
        if (req.body.foto_base64 && req.body.foto_base64.trim() !== "") {
            const base64Data = req.body.foto_base64.replace(/^data:image\/\w+;base64,/, "");
            fs.writeFileSync(path.resolve(__dirname, `../data/faces/${req.params.id}.jpg`), base64Data, 'base64');
            try { await axios.post('http://127.0.0.1:8000/api/reload_faces'); } catch(e) {} 
            res.json({ status: "ok" });
        } else {
            res.status(400).json({ error: "Foto não fornecida" });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/alunos/:id", authMiddleware, async (req, res) => {
    await runQuery("DELETE FROM alunos WHERE matricula=? AND usuario_id=?", [req.params.id, req.user.id]);
    const filePath = path.resolve(__dirname, `../data/faces/${req.params.id}.jpg`);
    if(fs.existsSync(filePath)) fs.unlinkSync(filePath);
    try { await axios.post('http://127.0.0.1:8000/api/reload_faces'); } catch(e) {}
    res.json({ status: "ok" });
});

app.get("/materias/:id/alunos", authMiddleware, async (req, res) => res.json(await allQuery("SELECT a.matricula, a.nome FROM alunos a JOIN turmas t ON a.turma_id = t.id JOIN materias m ON m.turma_id = t.id WHERE m.id = ? AND a.usuario_id = ?", [req.params.id, req.user.id])));

app.get("/assentos/:materia_id/:sala_id", authMiddleware, async (req, res) => res.json(await allQuery("SELECT aluno_matricula, bancada_nome FROM assentos WHERE materia_id = ? AND sala_id = ?", [req.params.materia_id, req.params.sala_id])));
app.post("/assentos", authMiddleware, async (req, res) => {
    await runQuery("DELETE FROM assentos WHERE materia_id = ? AND sala_id = ?", [req.body.materia_id, req.body.sala_id]);
    for(let a of req.body.assentos) await runQuery("INSERT INTO assentos (aluno_matricula, materia_id, sala_id, bancada_nome) VALUES (?, ?, ?, ?)", [a.aluno_matricula, req.body.materia_id, req.body.sala_id, a.bancada_nome]);
    res.json({ status: "ok" });
});

app.get("/aula/status", authMiddleware, async (req, res) => res.json(await getQuery(`SELECT a.id, a.materia_id, a.hora_inicio, m.nome as materia_nome, t.nome as turma_nome, s.nome as sala_nome, s.camera_url, s.id as sala_id FROM aulas a JOIN materias m ON a.materia_id = m.id JOIN turmas t ON m.turma_id = t.id JOIN salas s ON a.sala_id = s.id WHERE a.status = "EM_ANDAMENTO" AND a.usuario_id = ? ORDER BY a.id DESC LIMIT 1`, [req.user.id]) || null));
app.post("/aula/iniciar", authMiddleware, async (req, res) => {
    const ativo = await getQuery(`SELECT id FROM aulas WHERE status = "EM_ANDAMENTO" AND usuario_id = ?`, [req.user.id]);
    if(ativo) return res.status(400).json({ error: "Aula já em andamento" });
    const dia = new Date().toISOString().split('T')[0]; const hora = new Date().toTimeString().split(' ')[0].substring(0,8);
    await runQuery(`DELETE FROM live_status`); 
    await runQuery(`INSERT INTO aulas (materia_id, sala_id, data_dia, hora_inicio, status, usuario_id) VALUES (?, ?, ?, ?, "EM_ANDAMENTO", ?)`, [req.body.materia_id, req.body.sala_id, dia, hora, req.user.id]);
    res.json({ status: "ok" });
});
app.post("/aula/encerrar", authMiddleware, async (req, res) => {
    const hora = new Date().toTimeString().split(' ')[0].substring(0,8);
    await runQuery(`UPDATE aulas SET status="FINALIZADA", hora_fim=? WHERE status="EM_ANDAMENTO" AND usuario_id=?`, [hora, req.user.id]);
    await runQuery(`DELETE FROM live_status`); 
    res.json({ status: "ok" });
});

app.get("/aula/status_alunos", authMiddleware, async (req, res) => {
    const rows = await allQuery(`SELECT p1.aluno_id, al.nome as aluno_nome, p1.bancada_atual, p1.data_hora, p1.tipo, ast.bancada_nome as bancada_fixa FROM presenca p1 JOIN alunos al ON p1.aluno_id = al.matricula INNER JOIN (SELECT aluno_id, MAX(id) as max_id FROM presenca WHERE aula_id = (SELECT id FROM aulas WHERE status = "EM_ANDAMENTO" AND usuario_id = ? ORDER BY id DESC LIMIT 1) GROUP BY aluno_id) p2 ON p1.id = p2.max_id LEFT JOIN aulas a ON p1.aula_id = a.id LEFT JOIN assentos ast ON p1.aluno_id = ast.aluno_matricula AND a.materia_id = ast.materia_id AND a.sala_id = ast.sala_id`, [req.user.id]);
    const live = await allQuery(`SELECT * FROM live_status`);
    let result = [];
    for(let r of rows) {
        const stat_row = live.find(l => String(l.aluno_matricula) === String(r.aluno_id));
        result.push({ ...r, status_atencao: stat_row ? stat_row.status_atencao : "FOCADO" });
    }
    res.json(result);
});

app.get("/aulas/historico", authMiddleware, async (req, res) => res.json(await allQuery(`SELECT a.id, a.data_dia, a.hora_inicio, a.hora_fim, m.nome as materia_nome, t.nome as turma_nome, s.nome as sala_nome, a.status FROM aulas a JOIN materias m ON a.materia_id = m.id JOIN turmas t ON m.turma_id = t.id JOIN salas s ON a.sala_id = s.id WHERE a.usuario_id = ? ORDER BY a.id DESC LIMIT 50`, [req.user.id])));

app.get("/alertas", authMiddleware, async (req, res) => res.json(await allQuery(`SELECT a.id, a.mensagem, a.data_hora, a.video_file, a.image_file, m.nome as materia_nome, s.nome as sala_nome FROM alertas a JOIN aulas au ON a.aula_id = au.id JOIN materias m ON au.materia_id = m.id JOIN salas s ON au.sala_id = s.id WHERE au.usuario_id = ? ORDER BY a.id DESC LIMIT 100`, [req.user.id])));

app.post("/justificar", authMiddleware, async (req, res) => { const d = new Date().toISOString().replace('T', ' ').split('.')[0]; await runQuery("INSERT INTO justificativas (aula_id, aluno_matricula, motivo, data_registro) VALUES (?, ?, ?, ?)", [req.body.aula_id, req.body.aluno_matricula, req.body.motivo, d]); res.json({status:"ok"}); });

app.get("/analytics", authMiddleware, async (req, res) => {
    const total_alunos = (await getQuery("SELECT COUNT(*) as c FROM alunos WHERE usuario_id = ?", [req.user.id])).c;
    const total_aulas = (await getQuery("SELECT COUNT(*) as c FROM aulas WHERE usuario_id = ?", [req.user.id])).c;
    const total_alertas = (await getQuery("SELECT COUNT(*) as c FROM alertas a JOIN aulas au ON a.aula_id = au.id WHERE au.usuario_id = ?", [req.user.id])).c;
    const freq_turmas = await allQuery(`
        SELECT t.nome, 
               (SELECT COUNT(*) FROM alunos WHERE turma_id = t.id) as matriculados,
               (SELECT COUNT(DISTINCT p.aluno_id) FROM presenca p JOIN aulas a ON p.aula_id = a.id JOIN materias m ON a.materia_id = m.id WHERE m.turma_id = t.id) as presencas
        FROM turmas t WHERE t.usuario_id = ?
    `, [req.user.id]);
    res.json({ total_alunos, total_aulas, total_alertas, frequencia_turmas: freq_turmas });
});

app.get("/analytics/retencao", authMiddleware, async (req, res) => {
    let foco_pct = 100; let cel_pct = 0; let disp_pct = 0;
    const aula = await getQuery('SELECT id FROM aulas WHERE usuario_id = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
    if(aula) {
        const alrts = await allQuery("SELECT mensagem FROM alertas WHERE aula_id = ?", [aula.id]);
        let cel_count = alrts.filter(a => a.mensagem.includes("CELULAR")).length;
        let disp_count = alrts.filter(a => a.mensagem.includes("DISPERSÃO") || a.mensagem.includes("BRIGA")).length;
        if (cel_count > 0 || disp_count > 0) {
            cel_pct = Math.min(cel_count * 5, 100); 
            disp_pct = Math.min(disp_count * 3, 100 - cel_pct); 
            foco_pct = Math.max(100 - cel_pct - disp_pct, 0);
        }
    }
    res.json({ labels: ["Focado (%)", "Uso de Celular (%)", "Dispersão/Distração (%)"], data: [foco_pct, cel_pct, disp_pct] });
});

app.get("/aula/:id/relatorio", authMiddleware, async (req, res) => {
    try {
        let aulaId = req.params.id;
        if (aulaId === 'last') {
            const lastAula = await getQuery('SELECT id FROM aulas WHERE usuario_id = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
            if(!lastAula) return res.status(404).send("Nenhuma aula encontrada para gerar relatório.");
            aulaId = lastAula.id;
        }

        const aula = await getQuery("SELECT a.id, a.data_dia, a.hora_inicio, a.hora_fim, m.nome as materia_nome FROM aulas a JOIN materias m ON a.materia_id = m.id WHERE a.id = ?", [aulaId]);
        if(!aula) return res.status(404).send("Dados da aula não encontrados.");

        const justs = await allQuery("SELECT aluno_matricula, motivo FROM justificativas WHERE aula_id=?", [aulaId]);
        const alertas = await allQuery("SELECT mensagem, data_hora FROM alertas WHERE aula_id=?", [aulaId]);
        const presencas = await allQuery("SELECT al.matricula, al.nome, MIN(p.data_hora) as primeiro_registro, MAX(p.data_hora) as ultimo_registro, COUNT(p.id) as eventos FROM presenca p JOIN alunos al ON p.aluno_id = al.matricula WHERE p.aula_id = ? GROUP BY p.aluno_id", [aulaId]);

        const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Diário de Classe');
        sheet.mergeCells('A1:G1'); const titulo = sheet.getCell('A1'); 
        titulo.value = `DIÁRIO DE CLASSE - ${aula.materia_nome ? aula.materia_nome.toUpperCase() : "MATÉRIA"} - DATA: ${aula.data_dia}`; 
        titulo.font = { size: 14, bold: true }; titulo.alignment = { horizontal: 'center' };
        
        sheet.addRow(['MATRÍCULA', 'NOME DO ALUNO', 'ENTRADA', 'SAÍDA', 'TEMPO (min)', 'STATUS FINAL', 'OBSERVAÇÕES DA IA']);
        sheet.getRow(2).eachCell(c => { c.fill = {type: 'pattern', pattern:'solid', fgColor:{argb:'1E293B'}}; c.font = {color:{argb:'FFFFFF'}, bold:true}; c.alignment = {horizontal:'center'}; });

        presencas.forEach(p => {
            let status = "PRESENTE"; let tempo = 0;
            if(p.primeiro_registro && p.ultimo_registro) tempo = Math.round((new Date(p.ultimo_registro) - new Date(p.primeiro_registro)) / 60000);
            const just = justs.find(j => j.aluno_matricula === p.matricula); if(just) status = `JUSTIFICADO: ${just.motivo}`;
            
            let obs = []; 
            alertas.forEach(a => { 
                if(a.mensagem.includes(p.matricula) || a.mensagem.includes(p.nome)) { 
                    let h = a.data_hora.split(" ")[1]; 
                    if(a.mensagem.includes("CELULAR")) obs.push(`Celular (${h})`); 
                    if(a.mensagem.includes("DISPERSÃO") || a.mensagem.includes("BRIGA")) obs.push(`Distraído (${h})`); 
                } 
            });
            
            const row = sheet.addRow([p.matricula, p.nome, p.primeiro_registro, p.ultimo_registro, tempo, status, obs.join(' | ') || "Sem ocorrências."]);
            row.eachCell((c, i) => { c.alignment = (i===2||i===7) ? {horizontal:'left'} : {horizontal:'center'}; });
            const statCell = row.getCell(6); statCell.font = {color:{argb:'FFFFFF'}, bold:true};
            if(status.includes("JUSTIFICADO")) statCell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'3B82F6'}}; else if(status === "PRESENTE") statCell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'7AC142'}}; else statCell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'E30613'}};
        });

        sheet.columns.forEach(col => col.width = 25); sheet.getColumn(7).width = 45;
        
        sheet.addRow([]);
        const sumRow1 = sheet.addRow(['📊 RELATÓRIO COMPORTAMENTAL IA']);
        sumRow1.font = { bold: true, color: { argb: 'FFFFFF' } };
        sumRow1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E293B' } };
        sheet.mergeCells(`A${sumRow1.number}:G${sumRow1.number}`);
        
        let cel_count = alertas.filter(a => a.mensagem.includes("CELULAR")).length;
        let disp_count = alertas.filter(a => a.mensagem.includes("DISPERSÃO") || a.mensagem.includes("BRIGA")).length;
        let cel_pct = Math.min(cel_count * 5, 100);
        let disp_pct = Math.min(disp_count * 3, 100 - cel_pct);
        let foco_pct = Math.max(100 - cel_pct - disp_pct, 0);

        sheet.addRow(['Foco Geral da Turma:', `${foco_pct}%`]);
        sheet.addRow(['Índice de Uso de Celular:', `${cel_pct}%`]);
        sheet.addRow(['Índice de Dispersão:', `${disp_pct}%`]);
        
        const buffer = await workbook.xlsx.writeBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); 
        res.setHeader('Content-Disposition', `attachment; filename="DiarioClasse.xlsx"`);
        res.send(buffer);
    } catch(e) { console.error("Erro Excel:", e); res.status(500).send("Erro interno ao gerar planilha."); }
});

app.listen(3000, () => console.log("🟢 API Administrativa Node.js rodando na Porta 3000"));