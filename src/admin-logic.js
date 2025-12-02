import { auth, db, googleProvider } from './firebase-config.js';

// ELEMENTOS KPI
const kpiAlerts = document.getElementById('kpi-alerts');
const kpiMicrosleeps = document.getElementById('kpi-microsleeps');
const kpiLunches = document.getElementById('kpi-lunches');
const kpiActiveUsers = document.getElementById('kpi-active-users');

const tableBody = document.getElementById('logs-table-body');
const periodFilter = document.getElementById('period-filter');

const userFilter = document.getElementById('user-filter'); // NOVO SELETOR
const teamGrid = document.getElementById('team-grid-container');

const navBtns = document.querySelectorAll('.nav-btn[data-view]');
const views = document.querySelectorAll('.admin-view');

// Elementos Add Membro e Convite (Mantidos iguais)
const btnAddMember = document.getElementById('btn-add-member');
const addMemberModal = document.getElementById('add-member-modal');
const closeMemberModal = document.getElementById('close-add-member');
const formAddMember = document.getElementById('form-add-member'); // (Se existir, mantive por compatibilidade)
const inviteResultModal = document.getElementById('invite-result-modal');
const closeInviteResult = document.getElementById('close-invite-result');
const formCreateInvite = document.getElementById('form-create-invite');
const resultLinkInput = document.getElementById('result-link');
const resultMsgDiv = document.getElementById('result-message');
const btnCopyLink = document.getElementById('btn-copy-link');
const btnCopyMsg = document.getElementById('btn-copy-msg');
const btnShareWpp = document.getElementById('btn-share-wpp');

// Perfil
const adminFormProfile = document.getElementById('admin-form-profile');
const adminProfileName = document.getElementById('admin-profile-name');
const adminProfilePhoto = document.getElementById('admin-profile-photo');
const adminProfileEmail = document.getElementById('admin-profile-email');
const adminProfileRole = document.getElementById('admin-profile-role');
const adminProfilePreview = document.getElementById('admin-profile-preview');

// ESTADO GLOBAL
let charts = {}; 
let unsubscribeLogs = null;
let unsubscribeTeam = null;
let globalRawLogs = []; // Armazena todos os logs antes de filtrar

// --- AUTH & INIT ---
auth.onAuthStateChanged(async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    try {
        const userDoc = await db.collection('users').doc(user.uid).get();
        const role = userDoc.exists ? userDoc.data().role : 'USER';
        
        if (role !== 'ADMIN' && role !== 'OWNER') {
            alert("⛔ Acesso Negado: Apenas administradores.");
            window.location.href = 'index.html';
            return;
        }

        console.log(`🔓 Admin logado: ${role}`);
        
        // --- CONFIGURAÇÃO DA FOTO DE PERFIL (CLIQUE) ---
        const adminPhoto = document.getElementById('admin-photo');
        if(adminPhoto) {
            adminPhoto.src = user.photoURL;
            adminPhoto.style.cursor = 'pointer';
            adminPhoto.title = "Editar Meu Perfil";
            
            // Adiciona o evento de clique
            adminPhoto.onclick = () => {
                // 1. Remove classe active da sidebar
                navBtns.forEach(b => b.classList.remove('active'));
                
                // 2. Ativa o botão da sidebar correspondente
                const profileBtn = document.querySelector('.nav-btn[data-view="profile"]');
                if(profileBtn) profileBtn.classList.add('active');

                // 3. Troca a visualização para Perfil
                views.forEach(v => v.classList.remove('active'));
                const viewProfile = document.getElementById('view-profile');
                if(viewProfile) {
                    viewProfile.classList.add('active');
                    loadAdminProfile(); // Carrega os dados
                }
            };
        }
        // ------------------------------------------------

        setupRealtimeDashboard('today');
        setupTeamListener(); 

    } catch (error) {
        console.error("Erro de permissão:", error);
        window.location.href = 'index.html';
    }
});

// --- NAVEGAÇÃO ---
navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        navBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const viewId = btn.getAttribute('data-view');
        
        // Se clicar em Perfil, carrega os dados
        if(viewId === 'profile') {
            loadAdminProfile();
        }
        views.forEach(v => v.classList.remove('active'));
        const view = document.getElementById(`view-${viewId}`);
        if(view) view.classList.add('active');
    });
});

// --- LÓGICA DE PERFIL (ADMIN) ---

function loadAdminProfile() {
    const user = auth.currentUser;
    if(!user) return;

    adminProfileName.value = user.displayName || '';
    adminProfilePhoto.value = user.photoURL || '';
    adminProfileEmail.value = user.email || '';
    adminProfilePreview.src = user.photoURL || 'https://ui-avatars.com/api/?background=333&color=fff';
    
    // Busca a Role no Firestore pra mostrar
    db.collection('users').doc(user.uid).get().then(doc => {
        if(doc.exists) {
            adminProfileRole.value = doc.data().role || 'ADMIN';
        }
    });
}

// Preview da Imagem Admin
if(adminProfilePhoto) {
    adminProfilePhoto.addEventListener('input', (e) => {
        const url = e.target.value;
        if(url && url.length > 10) adminProfilePreview.src = url;
    });
}

// Salvar Perfil Admin
if(adminFormProfile) {
    adminFormProfile.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = adminFormProfile.querySelector('button');
        const originalText = btn.innerText;

        try {
            btn.disabled = true;
            btn.innerText = "Salvando...";
            
            const newName = adminProfileName.value;
            const newPhoto = adminProfilePhoto.value;

            // 1. Auth Profile
            await auth.currentUser.updateProfile({ displayName: newName, photoURL: newPhoto });

            // 2. Firestore
            await db.collection('users').doc(auth.currentUser.uid).update({ displayName: newName, photoURL: newPhoto });

            // 3. Atualiza header do admin
            const adminHeaderPhoto = document.getElementById('admin-photo');
            if (adminHeaderPhoto) {
                adminHeaderPhoto.style.cursor = 'pointer'; // Indica que é clicável
                adminHeaderPhoto.title = "Ir para Meu Perfil"; // Tooltip

                adminHeaderPhoto.addEventListener('click', () => {
                    // 1. Remove classe active de todos os botões da sidebar
                    navBtns.forEach(b => b.classList.remove('active'));
                    
                    // 2. Adiciona active no botão de perfil
                    const profileBtn = document.querySelector('.nav-btn[data-view="profile"]');
                    if(profileBtn) profileBtn.classList.add('active');

                    // 3. Troca a View
                    views.forEach(v => v.classList.remove('active'));
                    const profileView = document.getElementById('view-profile');
                    if(profileView) {
                        profileView.classList.add('active');
                        loadAdminProfile(); // Carrega os dados
                    }
                });
            }
            if(adminHeaderPhoto) adminHeaderPhoto.src = newPhoto;

            alert("Perfil de Administrador atualizado!");
            
        } catch (error) {
            console.error(error);
            alert("Erro: " + error.message);
        } finally {
            btn.disabled = false;
            btn.innerText = originalText;
        }
    });
}

// --- LISTENERS DOS FILTROS ---
if(periodFilter) {
    periodFilter.addEventListener('change', (e) => {
        if (unsubscribeLogs) unsubscribeLogs();
        setupRealtimeDashboard(e.target.value);
    });
}

// NOVO: Listener do Filtro de Usuário
if(userFilter) {
    userFilter.addEventListener('change', () => {
        filterAndRenderLogs(); // Apenas filtra o que já está na memória
    });
}

// --- LÓGICA DO DASHBOARD ---
function setupRealtimeDashboard(period) {
    console.log(`📡 Conectando stream: ${period}`);
    if(tableBody) tableBody.style.opacity = '0.5';

    // Determina a query baseada na data (Simplificado para 'today' por enquanto)
    const now = new Date();
    // Lógica simples de data (Pode ser expandida para query range no futuro)
    const todayFolder = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    
    let query;
    try {
        query = db.collectionGroup(todayFolder);
    } catch (e) {
        // Fallback se collectionGroup falhar (indexes)
        query = db.collection('logs').doc(auth.currentUser.uid).collection(todayFolder);
    }

    unsubscribeLogs = query.onSnapshot((snapshot) => {
        const logs = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            // Tenta pegar o UID do path se não vier no documento
            const uidFromPath = doc.ref.parent.parent ? doc.ref.parent.parent.id : null;
            logs.push({ ...data, uid: data.uid || uidFromPath });
        });
        
        // Salva no global e renderiza
        globalRawLogs = logs;
        if(tableBody) tableBody.style.opacity = '1';
        
        filterAndRenderLogs();

    }, (error) => {
        console.error("Erro Stream Logs:", error);
    });
}

// NOVA FUNÇÃO DE FILTRAGEM
function filterAndRenderLogs() {
    const selectedUser = userFilter.value;
    let filteredLogs = [];

    if (selectedUser === 'ALL') {
        filteredLogs = globalRawLogs;
    } else {
        filteredLogs = globalRawLogs.filter(log => log.uid === selectedUser);
    }

    processLogs(filteredLogs);
}

function processLogs(logs) {
    // Ordena logs crus para processamento
    logs.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds);

    // --- 1. CÁLCULO DE KPIs ---
    const criticalAlerts = logs.filter(l => l.type === 'ALARM' && l.reason && l.reason.includes('SONO PROFUNDO')).length;
    const microSleeps = logs.filter(l => l.type === 'ALARM' && l.reason && l.reason.includes('MICROSSONO')).length;
    
    // CORREÇÃO GRÁFICO: Conta apenas LUNCH_START para não duplicar o número de almoços
    const lunches = logs.filter(l => l.type === 'LUNCH_START').length;

    const uniqueUsers = new Set();
    logs.forEach(l => {
        if (l.uid) uniqueUsers.add(l.uid);
        else if (l.userName) uniqueUsers.add(l.userName);
    });
    
    // UI Updates KPI
    animateValue(kpiAlerts, criticalAlerts);
    animateValue(kpiMicrosleeps, microSleeps);
    animateValue(kpiLunches, lunches);
    
    if(kpiActiveUsers) {
        const count = uniqueUsers.size;
        kpiActiveUsers.innerText = count;
        const small = kpiActiveUsers.nextElementSibling;
        
        if (userFilter.value !== 'ALL') {
            if (small) small.innerText = count > 0 ? "Usuário Online" : "Sem dados hoje";
        } else {
            if (small) small.innerText = `${count} monitorados hoje`;
        }
    }

    renderCharts(logs);
    
    // --- 2. LÓGICA DE UNIFICAÇÃO (ALMOÇO) ---
    // Cria uma lista combinada onde Start+End viram uma única linha com duração
    const mergedLogs = mergeLunchEvents(logs);

    // Renderiza a tabela com os dados unificados (Alarmes + Almoços Unificados)
    renderGroupedTable(mergedLogs);
}

// NOVA FUNC: Junta o Início e o Fim do almoço
function mergeLunchEvents(rawLogs) {
    const combined = [];
    const activeLunches = new Map(); // Guarda temporariamente quem começou o almoço

    // Processamos do mais antigo pro mais novo pra casar Início -> Fim
    const sortedAsc = [...rawLogs].sort((a, b) => a.timestamp.seconds - b.timestamp.seconds);

    sortedAsc.forEach(log => {
        if (log.type === 'LUNCH_START') {
            // Guarda o início na memória
            activeLunches.set(log.uid, log);
        } 
        else if (log.type === 'LUNCH_END') {
            const startLog = activeLunches.get(log.uid);
            
            if (startLog) {
                // FECHOU O PAR: Calcula tempo
                const start = startLog.timestamp.toDate();
                const end = log.timestamp.toDate();
                const diffMs = end - start;
                const minutes = Math.floor(diffMs / 60000);
                
                const timeStrStart = start.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                const timeStrEnd = end.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

                combined.push({
                    ...startLog, // Mantém dados do usuário
                    type: 'LUNCH_REPORT', // Tipo especial pra tabela
                    timestamp: log.timestamp, // Usa a hora do fim para ordenação
                    reason: `Pausa Alimentar (${minutes} min)`, // Texto do Badge
                    details: `Das ${timeStrStart} às ${timeStrEnd}` // Texto detalhado
                });
                
                activeLunches.delete(log.uid); // Remove da memória
            } else {
                // Fim sem início (pode acontecer se o log de inicio foi perdido ou é de ontem)
                combined.push(log); 
            }
        } 
        else {
            // Alarmes e outros logs passam direto
            combined.push(log);
        }
    });

    // Quem sobrou no mapa ainda está almoçando
    activeLunches.forEach(log => {
        const start = log.timestamp.toDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        combined.push({
            ...log,
            type: 'LUNCH_ACTIVE',
            reason: 'Em Almoço',
            details: `Iniciado às ${start} (Em andamento)`
        });
    });

    // Retorna ordenado do mais recente para o antigo (para a tabela)
    return combined.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds);
}

// --- EQUIPE & POPULAÇÃO DO FILTRO ---
function setupTeamListener() {
    if(!teamGrid) return;
    
    unsubscribeTeam = db.collection('users').onSnapshot(snapshot => {
        teamGrid.innerHTML = ''; 
        
        // Limpa o select mas mantém a opção "Todos"
        if(userFilter) {
            const currentSelection = userFilter.value;
            userFilter.innerHTML = '<option value="ALL">Todos os Usuários</option>';
            
            // Variável auxiliar para repopular o select
            const usersList = [];

            snapshot.forEach(doc => {
                const data = doc.data();
                const uid = doc.id;
                const displayName = data.displayName || (data.email ? data.email.split('@')[0] : 'Sem Nome');
                
                usersList.push({ uid, name: displayName });

                // Renderiza Card na Aba Equipe
                renderTeamCard(data, displayName);
            });

            // Popula o Select
            usersList.forEach(u => {
                const option = document.createElement('option');
                option.value = u.uid;
                option.innerText = u.name;
                userFilter.appendChild(option);
            });

            // Tenta restaurar a seleção anterior se ainda existir
            userFilter.value = currentSelection;
        }

    }, error => {
        console.error("Erro ao carregar equipe:", error);
        teamGrid.innerHTML = '<div style="color: var(--danger);">Erro ao carregar dados.</div>';
    });
}

function renderTeamCard(data, displayName) {
    const photo = data.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=random&color=fff&background=333`;
    const isOnline = true; // Placeholder para lógica futura de presença

    const card = `
        <div class="team-card">
            <img src="${photo}" class="team-avatar">
            <h3 style="margin:0; font-size: 1rem;">${displayName}</h3>
            <p style="color:var(--text-muted); margin:5px 0 15px 0; font-size: 0.85rem;">${data.role || 'Usuário'}</p>
            <div style="font-size:0.8rem;">
                <span class="status-dot ${isOnline ? 'status-online' : ''}" style="background:${isOnline ? 'var(--safe)' : '#555'}"></span>
                <span style="color: var(--text-muted);">${isOnline ? 'Cadastrado' : 'Offline'}</span>
            </div>
            ${data.email ? `<small style="display:block; margin-top:10px; font-size:0.7rem; color:var(--text-muted); opacity: 0.7;">${data.email}</small>` : ''}
        </div>
    `;
    teamGrid.innerHTML += card;
}

// --- TABELA E GRÁFICOS (Mantidos e adaptados) ---

function renderGroupedTable(logs) {
    if(!tableBody) return;
    tableBody.innerHTML = '';
    
    // Header fixo da tabela
    const tableHeader = document.querySelector('.logs-table-container thead tr');
    if(tableHeader) {
        tableHeader.innerHTML = `
            <th style="width: 120px;">HORÁRIO</th>
            <th>COLABORADOR</th>
            <th>OCORRÊNCIA</th>
            <th style="text-align: right;">DETALHES</th>
        `;
    }

    if (logs.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: var(--text-muted); padding: 30px;">
            <span class="material-icons-round" style="font-size: 24px; vertical-align: middle; margin-right: 8px;">check_circle</span>
            Nenhum registro encontrado.
        </td></tr>`;
        return;
    }

    // Lógica de Agrupamento mantida, apenas ajustando a exibição
    const groups = [];
    let currentGroup = null;

    logs.forEach(log => {
        const userId = log.userName || log.uid || 'Desconhecido';
        // Agrupa apenas se for o mesmo usuário E não for um relatório de almoço (gosto de deixar almoço separado)
        // Mas para manter simples, vamos agrupar tudo por usuário sequencial
        if (currentGroup && currentGroup.userId === userId) {
            currentGroup.items.push(log);
        } else {
            if (currentGroup) groups.push(currentGroup);
            currentGroup = {
                userId: userId,
                userName: log.userName || 'Usuário',
                role: log.role || 'Vigia',
                items: [log]
            };
        }
    });
    if (currentGroup) groups.push(currentGroup);

    groups.forEach((group, index) => {
        const isMultiple = group.items.length > 1;
        const lastLog = group.items[0];
        const date = lastLog.timestamp.toDate();
        const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        
        // Define o texto do Badge (Alerta ou Almoço)
        let summaryText = isMultiple ? `<span style="color: #fff; font-weight: bold;">${group.items.length} Registros</span>` : (lastLog.reason || "Evento");
        
        // Cor do Badge
        let badgeClass = 'bg-danger'; // Vermelho para alertas
        if (lastLog.type === 'LUNCH_REPORT' || lastLog.type === 'LUNCH_ACTIVE') badgeClass = 'warning'; // Amarelo/Laranja (você pode criar classe .bg-warning no css ou usar style inline)
        
        // Badge HTML
        let badgeHtml = `<span class="badge ${badgeClass}" style="${badgeClass === 'warning' ? 'background: rgba(255, 149, 0, 0.2); color: #FF9500;' : ''}">${summaryText}</span>`;

        // Detalhes (Coluna da Direita)
        let actionHtml = '';
        if (lastLog.details) {
            actionHtml = `<span style="font-size: 0.85rem; color: var(--text-muted);">${lastLog.details}</span>`;
        } else if (isMultiple) {
            actionHtml = `<span class="material-icons-round" id="icon-group-${index}" style="color: var(--text-muted); transition: 0.3s;">expand_more</span>`;
        }

        const groupId = `group-${index}`;

        const mainRow = `
            <tr class="group-header" onclick="${isMultiple ? `toggleGroup('${groupId}')` : ''}" style="cursor: ${isMultiple ? 'pointer' : 'default'};">
                <td style="font-family: monospace; color: var(--primary);">
                    ${time}
                </td>
                <td>
                    <div style="display: flex; flex-direction: column;">
                        <span style="font-weight: 600;">${group.userName}</span>
                        <span style="font-size: 0.75rem; color: var(--text-muted);">${group.role}</span>
                    </div>
                </td>
                <td>${badgeHtml}</td>
                <td style="text-align: right;">
                    ${actionHtml}
                </td>
            </tr>
        `;
        tableBody.innerHTML += mainRow;

        if (isMultiple) {
            let detailsHtml = '';
            group.items.forEach(item => {
                const iTime = item.timestamp.toDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                // Se o item tiver 'details' (Almoço dentro de um grupo), mostra ele, senão mostra a reason (Alerta)
                const desc = item.details ? `<strong>${item.reason}</strong> - ${item.details}` : item.reason;
                
                detailsHtml += `
                    <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                        <span style="font-family: monospace; color: var(--text-muted); font-size: 0.85rem;">${iTime}</span>
                        <span style="color: #fff; font-size: 0.9rem;">${desc}</span>
                    </div>
                `;
            });
            tableBody.innerHTML += `
                <tr id="${groupId}" style="display: none; background: rgba(255,255,255,0.02);">
                    <td colspan="4" style="padding: 0 20px 20px 20px;">
                        <div style="background: rgba(0,0,0,0.3); border-radius: 8px; padding: 15px; margin-top: 5px;">
                            <div style="margin-top: 10px;">${detailsHtml}</div>
                        </div>
                    </td>
                </tr>
            `;
        }
    });
}

window.toggleGroup = function(id) {
    const el = document.getElementById(id);
    const icon = document.getElementById('icon-' + id);
    if (!el) return;
    if (el.style.display === 'none') {
        el.style.display = 'table-row';
        if(icon) icon.style.transform = 'rotate(180deg)';
    } else {
        el.style.display = 'none';
        if(icon) icon.style.transform = 'rotate(0deg)';
    }
};

function renderCharts(logs) {
    const ctxType = document.getElementById('typeChart').getContext('2d');
    const typeCounts = {
        'Sono Profundo': logs.filter(l => l.reason && l.reason.includes('SONO')).length,
        'Microssono': logs.filter(l => l.reason && l.reason.includes('MICRO')).length,
        'Almoço': logs.filter(l => l.type === 'LUNCH_START').length
    };
    
    if (charts.type) charts.type.destroy();
    charts.type = new Chart(ctxType, {
        type: 'doughnut',
        data: {
            labels: Object.keys(typeCounts),
            datasets: [{
                data: Object.values(typeCounts),
                backgroundColor: ['#FF453A', '#FFD028', '#FF9500'],
                borderWidth: 0
            }]
        },
        options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'right', labels: { color: '#fff' } } } }
    });

    const ctxFatigue = document.getElementById('fatigueChart').getContext('2d');
    const hours = Array(24).fill(0);
    logs.filter(l => l.type === 'ALARM').forEach(log => {
        const hour = log.timestamp.toDate().getHours();
        hours[hour]++;
    });
    
    if (charts.fatigue) charts.fatigue.destroy();
    charts.fatigue = new Chart(ctxFatigue, {
        type: 'line',
        data: {
            labels: hours.map((_, i) => `${i}h`),
            datasets: [{
                label: 'Alertas',
                data: hours,
                borderColor: '#FFD028',
                backgroundColor: 'rgba(255, 208, 40, 0.1)',
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 2,
            scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8E8E93' } }, x: { grid: { display: false }, ticks: { color: '#8E8E93' } } },
            plugins: { legend: { display: false } }
        }
    });
}

function animateValue(obj, end) {
    if(!obj) return;
    let startTimestamp = null;
    const duration = 1000;
    const start = parseInt(obj.innerHTML) || 0;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        obj.innerHTML = Math.floor(progress * (end - start) + start);
        if (progress < 1) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
}

// --- CONVITES (Mantido igual) ---
if(btnAddMember) {
    btnAddMember.style.display = 'flex'; 
    btnAddMember.addEventListener('click', () => {
        if(addMemberModal) {
            addMemberModal.classList.remove('hidden');
            setTimeout(() => addMemberModal.style.opacity = '1', 10);
        }
    });
}
[closeMemberModal, closeInviteResult].forEach(btn => {
    if(btn) btn.addEventListener('click', () => {
        if(addMemberModal) { addMemberModal.style.opacity = '0'; setTimeout(() => addMemberModal.classList.add('hidden'), 300); }
        if(inviteResultModal) { inviteResultModal.style.opacity = '0'; setTimeout(() => inviteResultModal.classList.add('hidden'), 300); }
    });
});

if(formCreateInvite) {
    formCreateInvite.addEventListener('submit', async (e) => {
        e.preventDefault();
        const role = document.getElementById('invite-role').value;
        const uses = parseInt(document.getElementById('invite-uses').value);
        const days = parseInt(document.getElementById('invite-days').value);
        const submitBtn = formCreateInvite.querySelector('button[type="submit"]');

        try {
            submitBtn.disabled = true;
            submitBtn.innerText = "Gerando...";
            const token = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + days);

            await db.collection('invites').doc(token).set({
                token: token,
                role: role,
                maxUses: uses,
                usesLeft: uses,
                expiresAt: expiresAt,
                createdBy: auth.currentUser.uid,
                createdAt: new Date(),
                active: true
            });

            const baseUrl = window.location.href.replace('admin.html', 'index.html');
            const finalLink = `${baseUrl.split('?')[0]}?convite=${token}`;
            const msgTemplate = `💼 *Convite Oficial - SunDrowsy*\n\nVocê foi convidado a integrar a plataforma *SunDrowsy* como *${role}*.\n\n📅 Expira em *${days} dia(s)*\n🔢 Válido para *${uses} uso(s)*\n\n*Clique no link abaixo para criar sua conta:*\n${finalLink}\n\n🛡️ *SunDrowsy* — Eficiência e segurança contra a fadiga.`;

            resultLinkInput.value = finalLink;
            resultMsgDiv.innerText = msgTemplate;

            addMemberModal.style.opacity = '0';
            setTimeout(() => addMemberModal.classList.add('hidden'), 300);
            inviteResultModal.classList.remove('hidden');
            setTimeout(() => inviteResultModal.style.opacity = '1', 300);

            btnCopyLink.onclick = () => { navigator.clipboard.writeText(finalLink); alert('Link copiado!'); };
            btnCopyMsg.onclick = () => { navigator.clipboard.writeText(msgTemplate); alert('Mensagem copiada!'); };
            btnShareWpp.onclick = () => { window.open(`https://wa.me/?text=${encodeURIComponent(msgTemplate)}`, '_blank'); };

            formCreateInvite.reset();
        } catch (error) {
            console.error("Erro ao gerar convite:", error);
            alert("Erro: " + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = "Gerar Link de Convite";
        }
    });
}