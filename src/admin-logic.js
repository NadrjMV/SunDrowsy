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

let tooltipEl = null;

let currentUserRole = 'USER';

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

    const now = new Date();
    // Lógica simples de data (aprimorada para pegar logs passados se necessário futuramente)
    const todayFolder = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    
    let query;
    try {
        // Tenta buscar em group (requer index) ou fallback para path direto
        query = db.collectionGroup(todayFolder); 
    } catch (e) {
        query = db.collection('logs').doc(auth.currentUser.uid).collection(todayFolder);
    }

    unsubscribeLogs = query.onSnapshot((snapshot) => {
        const logs = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            const uidFromPath = doc.ref.parent.parent ? doc.ref.parent.parent.id : null;
            
            logs.push({ 
                ...data, 
                uid: data.uid || uidFromPath,
                // *** CRÍTICO PARA DELEÇÃO ***
                id: doc.id,               // ID do documento
                dateFolder: doc.ref.parent.id // Nome da coleção (ex: 2023-10-13)
            });
        });
        
        globalRawLogs = logs;
        if(tableBody) tableBody.style.opacity = '1';
        
        // Verifica se é OWNER para mostrar botões de perigo
        checkOwnerPermissions();

        filterAndRenderLogs();

    }, (error) => {
        console.error("Erro Stream Logs:", error);
    });
}

// Verifica permissão e mostra/esconde botões
function checkOwnerPermissions() {
    const user = auth.currentUser;
    if (user) {
        db.collection('users').doc(user.uid).get().then(doc => {
            if (doc.exists) {
                currentUserRole = doc.data().role;
                
                // COMENTEI A LINHA QUE MOSTRAVA O BOTÃO
                /* const btnWipe = document.getElementById('btn-wipe-logs');
                if (currentUserRole === 'OWNER' && btnWipe) {
                    btnWipe.style.display = 'inline-flex';
                } 
                */

                // Apenas re-renderiza a tabela para mostrar as lixeirinhas individuais (se quiser)
                // Se quiser esconder até as individuais, comente a linha abaixo também.
                renderGroupedTable(mergeLunchEvents(globalRawLogs)); 
            }
        });
    }
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

    // Renderiza os gráficos
    renderCharts(logs);
    
    // Renderiza as Tabelas
    const mergedLogs = mergeLunchEvents(logs);
    renderGroupedTable(mergedLogs);

    // --- RENDERIZA A ABA RELATÓRIOS ---
    renderReports(logs);
}

// --- LÓGICA DE RELATÓRIOS (RANKING & HEATMAP) ---
function renderReports(logs) {
    if (!logs || logs.length === 0) return;

    // --- CRIAÇÃO DO TOOLTIP (SE NÃO EXISTIR) ---
    if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'heatmap-tooltip';
        document.body.appendChild(tooltipEl);
    }

    const alarmLogs = logs.filter(l => l.type === 'ALARM');

    // Preparação de Dados
    const userStats = {};
    const heatmapData = {}; 

    alarmLogs.forEach(log => {
        const uid = log.uid || 'anon';
        const name = log.userName || 'Desconhecido';
        
        // Totais para Ranking
        if (!userStats[uid]) userStats[uid] = { name: name, count: 0, uid: uid };
        userStats[uid].count++;

        // Totais para Heatmap
        const hour = log.timestamp.toDate().getHours(); 
        if (!heatmapData[uid]) heatmapData[uid] = Array(24).fill(0);
        heatmapData[uid][hour]++;
    });

    const sortedUsers = Object.values(userStats).sort((a, b) => b.count - a.count);

    // --- GRÁFICO RANKING (CORRIGIDO: NOMES VISÍVEIS) ---
    const ctxRanking = document.getElementById('rankingChart');
    if (ctxRanking) {
        if (charts.ranking) charts.ranking.destroy();
        charts.ranking = new Chart(ctxRanking.getContext('2d'), {
            type: 'bar',
            data: {
                labels: sortedUsers.slice(0, 5).map(u => u.name),
                datasets: [{
                    label: 'Alertas',
                    data: sortedUsers.slice(0, 5).map(u => u.count),
                    backgroundColor: ['#FF453A', '#FF9F0A', '#FFD60A', '#32D74B', '#64D2FF'],
                    borderWidth: 0, borderRadius: 4, barThickness: 20
                }]
            },
            options: {
                indexAxis: 'y', // Barra Horizontal
                responsive: true, 
                maintainAspectRatio: false,
                scales: { 
                    x: { 
                        grid: { color: 'rgba(255,255,255,0.05)' }, 
                        ticks: { color: '#8E8E93' } 
                    }, 
                    y: { 
                        display: true, // <--- OBRIGATÓRIO TRUE PARA MOSTRAR NOMES
                        grid: { display: false }, // Esconde linhas de grade mas mantém nomes
                        ticks: { 
                            color: '#fff', // Texto Branco
                            font: { size: 11, weight: '600' } 
                        } 
                    } 
                },
                plugins: { legend: { display: false } }
            }
        });
    }

    // --- MAPA DE CALOR ---
    const heatmapContainer = document.getElementById('heatmap-container');
    if (heatmapContainer) {
        let html = '<div class="heatmap-grid">';
        
        // Header
        html += '<div style="font-size:0.7rem; color:#888; text-align:right; padding-right:10px; align-self:end;">COLABORADOR</div>'; 
        for (let h = 0; h < 24; h++) {
            const hh = String(h).padStart(2, '0');
            html += `<div class="heatmap-header-cell">${hh}h</div>`;
        }
        html += '<div class="heatmap-header-cell">TTL</div>';

        // Linhas
        const usersToRender = sortedUsers.slice(0, 10);
        
        if (usersToRender.length === 0) {
            html += '<div style="grid-column: 1/-1; padding:30px; text-align:center; color: var(--text-muted);">Nenhum dado térmico capturado hoje.</div>';
        } else {
            usersToRender.forEach(user => {
                // Escapa aspas para o onclick
                const safeName = user.name.replace(/'/g, "\\'"); 
                html += `<div class="heatmap-user-label" title="${user.name}">${user.name.split(' ')[0]}</div>`;
                
                const hours = heatmapData[user.uid] || Array(24).fill(0);
                let userTotal = 0;

                hours.forEach((count, hourIndex) => {
                    userTotal += count;
                    let heatClass = '';
                    let clickAction = '';

                    if (count > 0) {
                        if (count === 1) heatClass = 'heat-lvl-1';
                        else if (count >= 2 && count <= 3) heatClass = 'heat-lvl-2';
                        else if (count >= 4 && count <= 5) heatClass = 'heat-lvl-3';
                        else if (count >= 6) heatClass = 'heat-lvl-4';
                        
                        clickAction = `onclick="openHeatmapDetails('${user.uid}', '${safeName}', ${hourIndex})"`;
                    }

                    html += `<div class="heatmap-cell ${heatClass}" 
                                  ${clickAction}
                                  onmouseover="showTooltip(event, '${safeName}', ${hourIndex}, ${count})" 
                                  onmousemove="moveTooltip(event)" 
                                  onmouseout="hideTooltip()">
                             </div>`;
                });

                html += `<div class="heatmap-total-label">${userTotal}</div>`;
            });
        }
        html += '</div>';
        heatmapContainer.innerHTML = html;
    }
}

// --- LÓGICA DO MODAL DE DETALHES ---

// 1. Elementos do Modal
const hmModal = document.getElementById('heatmap-details-modal');
const hmTitle = document.getElementById('hm-modal-title');
const hmSubtitle = document.getElementById('hm-modal-subtitle');
const hmList = document.getElementById('hm-logs-list');
const btnCloseHm = document.getElementById('close-hm-modal');
const btnCloseHmFooter = document.getElementById('btn-close-hm-footer');

// 2. Fechar Modal
if(btnCloseHm) btnCloseHm.onclick = () => hmModal.classList.add('hidden');
if(btnCloseHmFooter) btnCloseHmFooter.onclick = () => hmModal.classList.add('hidden');

// 3. Função Global (Window) para abrir o modal
window.openHeatmapDetails = function(uid, name, hour) {
    if (!globalRawLogs || globalRawLogs.length === 0) return;

    // A. Filtra os logs exatos (Mesmo UID, Mesma Hora, Apenas Alarmes)
    const filtered = globalRawLogs.filter(log => {
        const logHour = log.timestamp.toDate().getHours();
        return log.uid === uid && logHour === hour && log.type === 'ALARM';
    });

    if (filtered.length === 0) return;

    // B. Popula o Header
    const hourStr = String(hour).padStart(2, '0');
    hmTitle.innerText = `Incidentes: ${name}`;
    hmSubtitle.innerText = `Horário: ${hourStr}:00 às ${hourStr}:59 • Total: ${filtered.length} ocorrências`;

    // C. Gera a Lista HTML
    hmList.innerHTML = '';
    
    // Ordena por minuto/segundo
    filtered.sort((a, b) => a.timestamp.seconds - b.timestamp.seconds);

    filtered.forEach(log => {
        const date = log.timestamp.toDate();
        const timeStr = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        const item = document.createElement('div');
        item.className = 'log-item-card';
        item.innerHTML = `
            <div style="display:flex; align-items:center;">
                <span class="material-icons-round log-type-icon">warning</span>
                <div>
                    <div class="log-reason">${log.reason}</div>
                    <small style="color:var(--text-muted); font-size:0.75rem;">Fadiga: ${log.fatigue_level || 'N/A'}</small>
                </div>
            </div>
            <div class="log-time">${timeStr}</div>
        `;
        hmList.appendChild(item);
    });

    // D. Abre o Modal
    hmModal.classList.remove('hidden');
};

// Funções de Tooltip (Mantidas)
window.showTooltip = function(e, name, hour, count) {
    if(!tooltipEl) return;
    if(count === 0) return;
    const hourStr = String(hour).padStart(2, '0') + ":00";
    const nextHourStr = String(hour + 1).padStart(2, '0') + ":00";
    tooltipEl.innerHTML = `
        <h4>${name}</h4>
        <span>Horário: <strong>${hourStr} - ${nextHourStr}</strong></span>
        <span>Alertas: <strong style="color:var(--primary);">${count}</strong></span>
        <span style="font-size:0.65rem; color:#888; margin-top:4px; border-top:1px solid rgba(255,255,255,0.1); padding-top:4px;">
            <span class="material-icons-round" style="font-size:10px; vertical-align:middle;">touch_app</span> Clique para ver detalhes
        </span>
    `;
    tooltipEl.style.display = 'block';
    moveTooltip(e);
};

window.moveTooltip = function(e) {
    if(!tooltipEl) return;
    // Pega a posição do mouse e soma um offset
    const x = e.clientX + 15;
    const y = e.clientY + 15;
    
    // Evita sair da tela (básico)
    tooltipEl.style.left = x + 'px';
    tooltipEl.style.top = y + 'px';
};

window.hideTooltip = function() {
    if(tooltipEl) tooltipEl.style.display = 'none';
};

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
    
    // Header fixo (Adicionando coluna Ações se for OWNER)
    const tableHeader = document.querySelector('.logs-table-container thead tr');
    const isOwner = (currentUserRole === 'OWNER');

    if(tableHeader) {
        tableHeader.innerHTML = `
            <th style="width: 120px;">HORÁRIO</th>
            <th>COLABORADOR</th>
            <th>OCORRÊNCIA</th>
            <th style="text-align: right;">DETALHES</th>
            ${isOwner ? '<th style="width: 50px;"></th>' : ''} 
        `;
    }

    if (logs.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="${isOwner ? 5 : 4}" style="text-align:center; color: var(--text-muted); padding: 30px;">
            <span class="material-icons-round" style="font-size: 24px; vertical-align: middle; margin-right: 8px;">check_circle</span>
            Nenhum registro encontrado.
        </td></tr>`;
        return;
    }

    const groups = [];
    let currentGroup = null;

    logs.forEach(log => {
        const userId = log.userName || log.uid || 'Desconhecido';
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
        
        let summaryText = isMultiple ? `<span style="color: #fff; font-weight: bold;">${group.items.length} Registros</span>` : (lastLog.reason || "Evento");
        let badgeClass = (lastLog.type === 'LUNCH_REPORT' || lastLog.type === 'LUNCH_ACTIVE') ? 'warning' : 'bg-danger';
        let badgeHtml = `<span class="badge ${badgeClass}" style="${badgeClass === 'warning' ? 'background: rgba(255, 149, 0, 0.2); color: #FF9500;' : ''}">${summaryText}</span>`;

        let actionHtml = '';
        if (lastLog.details) {
            actionHtml = `<span style="font-size: 0.85rem; color: var(--text-muted);">${lastLog.details}</span>`;
        } else if (isMultiple) {
            actionHtml = `<span class="material-icons-round" id="icon-group-${index}" style="color: var(--text-muted); transition: 0.3s;">expand_more</span>`;
        }

        const groupId = `group-${index}`;
        
        // Botão Delete (Lixeira) para a linha principal
        // Se for grupo, deleta o grupo inteiro (implementação avançada) ou avisa.
        // Por segurança, vamos permitir deletar individualmente dentro do grupo, 
        // mas se for item único, deleta direto.
        let deleteBtn = '';
        if (isOwner) {
            if (!isMultiple) {
                // Item único
                deleteBtn = `
                <td style="text-align: right; width: 50px;">
                    <button class="btn-icon-danger" onclick="confirmDeleteOne('${lastLog.uid}', '${lastLog.dateFolder}', '${lastLog.id}')" title="Apagar Registro">
                        <span class="material-icons-round">delete</span>
                    </button>
                </td>`;
            } else {
                deleteBtn = `<td></td>`;
            }
        }

        const mainRow = `
            <tr class="group-header" onclick="${isMultiple ? `toggleGroup('${groupId}')` : ''}" style="cursor: ${isMultiple ? 'pointer' : 'default'};">
                <td style="font-family: monospace; color: var(--primary);">${time}</td>
                <td>
                    <div style="display: flex; flex-direction: column;">
                        <span style="font-weight: 600;">${group.userName}</span>
                        <span style="font-size: 0.75rem; color: var(--text-muted);">${group.role}</span>
                    </div>
                </td>
                <td>${badgeHtml}</td>
                <td style="text-align: right;">${actionHtml}</td>
                ${deleteBtn}
            </tr>
        `;
        tableBody.innerHTML += mainRow;

        if (isMultiple) {
            let detailsHtml = '';
            group.items.forEach(item => {
                const iTime = item.timestamp.toDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const desc = item.details ? `<strong>${item.reason}</strong> - ${item.details}` : item.reason;
                
                // Botão Delete Individual dentro do grupo
                const itemDelete = isOwner ? `
                    <button class="btn-icon-danger" onclick="confirmDeleteOne('${item.uid}', '${item.dateFolder}', '${item.id}')" title="Apagar Item">
                        <span class="material-icons-round" style="font-size: 18px;">delete</span>
                    </button>
                ` : '';

                detailsHtml += `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                        <div style="display:flex; gap: 15px;">
                            <span style="font-family: monospace; color: var(--text-muted); font-size: 0.85rem;">${iTime}</span>
                            <span style="color: #fff; font-size: 0.9rem;">${desc}</span>
                        </div>
                        ${itemDelete}
                    </div>
                `;
            });
            tableBody.innerHTML += `
                <tr id="${groupId}" style="display: none; background: rgba(255,255,255,0.02);">
                    <td colspan="${isOwner ? 5 : 4}" style="padding: 0 20px 20px 20px;">
                        <div style="background: rgba(0,0,0,0.3); border-radius: 8px; padding: 15px; margin-top: 5px;">
                            <div style="margin-top: 10px;">${detailsHtml}</div>
                        </div>
                    </td>
                </tr>
            `;
        }
    });
}

// --- LÓGICA DE DELEÇÃO (APENAS OWNER) ---

// 1. Deletar UM ÚNICO log
window.confirmDeleteOne = async function(uid, dateFolder, docId) {
    // Para a propagação do clique (evita abrir/fechar o grupo se tiver)
    if(window.event) window.event.stopPropagation();

    if (!confirm("⚠️ ATENÇÃO: Deseja apagar este registro permanentemente?\nEssa ação não pode ser desfeita.")) {
        return;
    }

    try {
        await db.collection('logs').doc(uid).collection(dateFolder).doc(docId).delete();
        // O onSnapshot vai atualizar a tela automaticamente
        console.log("Log deletado com sucesso.");
    } catch (error) {
        console.error("Erro ao deletar:", error);
        alert("Erro ao deletar: " + error.message);
    }
};

// 2. Lógica do Botão "Limpar Geral / Usuário"
const btnWipe = document.getElementById('btn-wipe-logs');
const btnWipeText = document.getElementById('btn-wipe-text');

if (userFilter && btnWipeText) {
    // Atualiza o texto do botão conforme o filtro
    userFilter.addEventListener('change', () => {
        if (userFilter.value === 'ALL') {
            btnWipeText.innerText = "Limpar TUDO (Vista)";
        } else {
            const userName = userFilter.options[userFilter.selectedIndex].text;
            btnWipeText.innerText = `Limpar logs de ${userName.split(' ')[0]}`;
        }
    });
}

if (btnWipe) {
    btnWipe.addEventListener('click', async () => {
        if (!globalRawLogs || globalRawLogs.length === 0) return alert("Nada para deletar.");

        const selectedUser = userFilter.value;
        let logsToDelete = [];
        let confirmMsg = "";

        // Define o que deletar baseado no filtro visual atual
        if (selectedUser === 'ALL') {
            logsToDelete = globalRawLogs; // Deleta tudo que está carregado na memória/tela
            confirmMsg = `🚨 PERIGO EXTREMO 🚨\n\nVocê está prestes a apagar TODOS os ${logsToDelete.length} registros visíveis na tela.\n\nIsso limpará os dados de TODOS os usuários no período selecionado.\n\nTem certeza absoluta?`;
        } else {
            logsToDelete = globalRawLogs.filter(l => l.uid === selectedUser);
            confirmMsg = `⚠️ Você está prestes a apagar todos os ${logsToDelete.length} registros do usuário selecionado.\n\nConfirma a exclusão?`;
        }

        if (logsToDelete.length === 0) return alert("Nenhum log encontrado para este filtro.");

        if (confirm(confirmMsg)) {
            // Dupla verificação para Limpar Tudo
            if (selectedUser === 'ALL') {
                const check = prompt("Digite 'DELETAR' para confirmar a exclusão em massa:");
                if (check !== 'DELETAR') return alert("Ação cancelada.");
            }

            btnWipe.disabled = true;
            btnWipe.innerText = "Deletando...";

            // Processo em Batch (Lotes de 500, limite do Firestore)
            const total = logsToDelete.length;
            let deleted = 0;
            const batchSize = 400; // Margem de segurança
            
            try {
                // Como os logs estão espalhados em subcollections diferentes (por dia/uid), 
                // não dá pra usar um batch único simples. Vamos fazer Promises paralelas.
                // Para não estourar o limite de conexões, fazemos em chunks.
                
                for (let i = 0; i < total; i += batchSize) {
                    const chunk = logsToDelete.slice(i, i + batchSize);
                    const promises = chunk.map(log => {
                        if (log.uid && log.dateFolder && log.id) {
                            return db.collection('logs').doc(log.uid).collection(log.dateFolder).doc(log.id).delete();
                        }
                        return Promise.resolve();
                    });
                    
                    await Promise.all(promises);
                    deleted += chunk.length;
                    console.log(`Deletados ${deleted}/${total}...`);
                }

                alert("Limpeza concluída com sucesso.");

            } catch (error) {
                console.error("Erro na deleção em massa:", error);
                alert("Ocorreu um erro durante a deleção. Atualize a página.");
            } finally {
                btnWipe.disabled = false;
                btnWipe.innerHTML = '<span class="material-icons-round" style="font-size: 18px; vertical-align: middle;">delete_forever</span> <span id="btn-wipe-text">Limpar Vista</span>';
            }
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

// --- LÓGICA DE EXPORTAÇÃO CSV ---

const btnExportCsv = document.getElementById('btn-export-csv');

if (btnExportCsv) {
    btnExportCsv.addEventListener('click', () => {
        exportLogsToCSV();
    });
}

function exportLogsToCSV() {
    // 1. Verifica se há dados
    if (!globalRawLogs || globalRawLogs.length === 0) {
        alert("Não há dados para exportar.");
        return;
    }

    // 2. Aplica o filtro atual da tela (O mesmo do dropdown)
    const selectedUser = userFilter.value;
    let dataToExport = [];

    if (selectedUser === 'ALL') {
        dataToExport = [...globalRawLogs];
    } else {
        dataToExport = globalRawLogs.filter(log => log.uid === selectedUser);
    }

    // Ordena por data (mais recente primeiro)
    dataToExport.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds);

    // 3. Cabeçalho do CSV
    const headers = ['DATA', 'HORA', 'NOME', 'CARGO', 'TIPO EVENTO', 'MOTIVO/DESCRIÇÃO', 'DETALHES EXTRAS'];
    
    // 4. Processa as linhas
    const csvRows = dataToExport.map(log => {
        const dateObj = log.timestamp.toDate();
        const dateStr = dateObj.toLocaleDateString('pt-BR');
        const timeStr = dateObj.toLocaleTimeString('pt-BR');
        
        // Trata campos de texto para evitar quebras no CSV (aspas e vírgulas)
        const clean = (text) => {
            if (!text) return "";
            return `"${text.toString().replace(/"/g, '""')}"`; // Escapa aspas duplas
        };

        const userName = clean(log.userName || 'Desconhecido');
        const role = clean(log.role || '--');
        const type = clean(log.type);
        const reason = clean(log.reason || log.description || ''); // Pega reason ou description (almoço)
        
        // Detalhes extras (como nível de fadiga)
        let details = "";
        if (log.fatigue_level) details = `Nível: ${log.fatigue_level}`;
        details = clean(details);

        return [dateStr, timeStr, userName, role, type, reason, details].join(',');
    });

    // 5. Monta o conteúdo final com BOM para UTF-8 (Acentos funcionarem no Excel)
    const csvContent = '\uFEFF' + [headers.join(','), ...csvRows].join('\n');

    // 6. Cria o arquivo e dispara o download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    // Nome do arquivo dinâmico
    const today = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
    const filterSuffix = selectedUser === 'ALL' ? 'Geral' : 'Filtrado';
    link.setAttribute('href', url);
    link.setAttribute('download', `SunDrowsy_Relatorio_${filterSuffix}_${today}.csv`);
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// --- FECHAMENTO GLOBAL DE MODAIS (ESC & CLIQUE FORA) ---

// 1. Fechar com tecla ESC
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const activeModals = document.querySelectorAll('.modal:not(.hidden)');
        activeModals.forEach(modal => {
            modal.style.opacity = '0'; // Animação de saída
            setTimeout(() => modal.classList.add('hidden'), 300);
        });
    }
});

// 2. Fechar clicando no fundo (Backdrop)
window.addEventListener('click', (e) => {
    // Se o alvo do clique tiver a classe 'modal' (significa que clicou no fundo escuro e não no conteúdo)
    if (e.target.classList.contains('modal')) {
        e.target.style.opacity = '0';
        setTimeout(() => e.target.classList.add('hidden'), 300);
    }
});