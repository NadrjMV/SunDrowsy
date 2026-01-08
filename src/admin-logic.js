import { auth, db, googleProvider } from './firebase-config.js';
// Import da config nova
import { APP_CONFIG } from './config.js';

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

// --- VARIÁVEL LOCAL DO MÓDULO EQUIPE ---
let localUsersList = [];

let tooltipEl = null;

let currentUserRole = 'USER';

window.destroyerMode = false;

// Injeta versão no footer da sidebar (Admin)
(function injectAdminVersion() {
    const footer = document.querySelector('.sidebar .dev-footer'); // seletor mais específico caso tenha outros footers
    if (footer) {
        // Cria o elemento da versão
        const verSpan = document.createElement('span');
        verSpan.style.display = 'block';
        verSpan.style.marginTop = '2px';
        verSpan.style.opacity = '0.3';
        verSpan.style.fontSize = '0.6rem';
        verSpan.style.fontFamily = 'monospace';
        verSpan.innerText = `v${APP_CONFIG.VERSION}`;
        
        // Adiciona ao final do footer existente
        footer.appendChild(verSpan);
    }
})();

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
            window.location.href = 'index.html';
            return;
        }

        currentUserRole = role;

        // Flags globais para UI/ações (menu equipe, etc)
        window.currentAdminRole = role;
        window.isSystemOwner = (role === 'OWNER');

        // Chamadas iniciais
        populateUserFilter(); // Popula os nomes no filtro
        setupRealtimeDashboard('today');

        // Equipe (UI + ações + convites)
        setupTeamListener();
        setupInviteSystem();
        setupModalsTeam();

        // Verifica se é owner para ativar o modo owner (limpar logs etc)
        checkOwnerPermissions(user.uid);

    } catch (error) {
        console.error("Erro no carregamento inicial:", error);
    }
});

// Verifica permissão e ATIVA o modo destruidor automaticamente se for OWNER
function checkOwnerPermissions(uid) {
    if (!uid) return;
    
    db.collection('users').doc(uid).get().then(doc => {
        if (doc.exists) {
            currentUserRole = doc.data().role;
            
            // Se o banco diz que é OWNER, ativamos a UI de deletar automaticamente.
            if (currentUserRole === 'OWNER') {
                activateDestroyerUI(); 
            }
        }
    });
}

// Função interna (não exposta no window) para ligar os botões
function activateDestroyerUI() {
    console.log("🔒 Painel de Controle: Modo Owner Ativo.");
    
    // 1. Seta a flag interna
    window.destroyerMode = true;
    window.isSystemOwner = true;
    window.currentAdminRole = 'OWNER';
// 2. Mostra o Botão Mestre de Limpeza
    const btnWipe = document.getElementById('btn-wipe-logs');
    if(btnWipe) {
        btnWipe.style.display = 'inline-flex';
        btnWipe.disabled = false;
        btnWipe.style.opacity = '1';
        btnWipe.style.cursor = 'pointer';
    }

    // 3. Atualiza a tabela para mostrar as lixeirinhas individuais
    if(typeof filterAndRenderLogs === 'function') {
        filterAndRenderLogs();
    } else if (typeof renderGroupedTable === 'function') {
        renderGroupedTable(mergeLunchEvents(globalRawLogs));
    }
}

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
                adminHeaderPhoto.style.cursor = 'pointer'; 
                adminHeaderPhoto.title = "Ir para Meu Perfil"; 

                adminHeaderPhoto.addEventListener('click', () => {
                    navBtns.forEach(b => b.classList.remove('active'));
                    const profileBtn = document.querySelector('.nav-btn[data-view="profile"]');
                    if(profileBtn) profileBtn.classList.add('active');
                    views.forEach(v => v.classList.remove('active'));
                    const profileView = document.getElementById('view-profile');
                    if(profileView) {
                        profileView.classList.add('active');
                        loadAdminProfile();
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

if(userFilter) {
    userFilter.addEventListener('change', () => {
        if (unsubscribeLogs) unsubscribeLogs();
        setupRealtimeDashboard(periodFilter ? periodFilter.value : 'today');
    });
}

// --- LÓGICA DO DASHBOARD (CORE) ---
function formatDateFolder(dateObj) {
    // YYYY-MM-DD em UTC-3 local (usa o relógio do navegador)
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function buildDateFolders(startDate, endDate) {
    const folders = [];
    const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    while (d <= end) {
        folders.push(formatDateFolder(d));
        d.setDate(d.getDate() + 1);
    }
    return folders;
}

async function fetchLegacyLogsForUsers(uids, dateFolders, startDate, concurrency = 12) {
    // LEGADO (lento por natureza): /logs/{uid}/{YYYY-MM-DD}/{doc}
    // Otimização: executa as consultas em paralelo com limite de concorrência.
    const out = [];
    const tasks = [];
    for (const uid of uids) {
        for (const folder of dateFolders) tasks.push({ uid, folder });
    }
    if (!tasks.length) return out;

    let cursor = 0;

    async function worker() {
        while (cursor < tasks.length) {
            const i = cursor++;
            const { uid, folder } = tasks[i];
            try {
                const snap = await db.collection('logs').doc(uid).collection(folder)
                    .where('timestamp', '>=', startDate)
                    .orderBy('timestamp', 'desc')
                    .get();

                snap.forEach(doc => {
                    const data = doc.data();
                    out.push({
                        ...data,
                        id: doc.id,
                        uid: data.uid || uid,
                        dateFolder: folder,
                        __source: 'legacy'
                    });
                });
            } catch (e) {
                // Normal: coleção pode não existir no dia OU pode faltar índice.
            }
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
    await Promise.all(workers);
    return out;
}

async function fetchUnifiedLogs(period, selectedUid) {
    const now = new Date();
    let startDate = new Date();

    if (period === 'week') startDate.setDate(now.getDate() - 7);
    else if (period === 'month') startDate.setMonth(now.getMonth() - 1);
    else startDate.setHours(0, 0, 0, 0);

    // range de pastas (para legado)
    const dateFolders = buildDateFolders(startDate, now);

    // uids alvo
    let uids = [];
    if (selectedUid && selectedUid !== 'ALL') {
        uids = [selectedUid];
    } else {
        const usersSnap = await db.collection('users').get();
        usersSnap.forEach(u => uids.push(u.id));
    }

    // NOVO: collectionGroup('logs') => /logs/{uid}/logs/{doc}
    const unified = [];
    try {
        const snap = await db.collectionGroup('logs')
            .where('timestamp', '>=', startDate)
            .orderBy('timestamp', 'desc')
            .get();

        snap.forEach(doc => {
            const data = doc.data();
            const uidFromPath = doc.ref.parent.parent ? doc.ref.parent.parent.id : null;

            // se estiver filtrando por usuário, aplica aqui pra não encher memória
            if (selectedUid && selectedUid !== 'ALL') {
                const target = data.uid || uidFromPath;
                if (target !== selectedUid) return;
            }

            unified.push({
                ...data,
                id: doc.id,
                uid: data.uid || uidFromPath,
                dateFolder: doc.ref.parent.id,
                __source: 'unified'
            });
        });
    } catch (e) {
        console.error("❌ Erro ao buscar logs unificados:", e);
    }

    let legacy = [];
const shouldFetchLegacy =
    (period === 'today') || (selectedUid && selectedUid !== 'ALL');

// Performance mode:
// - 'today' carrega legado (só 1 pasta/dia) => rápido
// - 'week'/'month' só carrega legado quando você filtra 1 usuário (evita varrer a equipe inteira)
if (shouldFetchLegacy) {
    const legacyConcurrency = (period === 'today') ? 24 : 10;
    legacy = await fetchLegacyLogsForUsers(uids, dateFolders, startDate, legacyConcurrency);
} else {
    console.warn("⚡ Performance: pulando legado em 'week/month' com 'Todos os Usuários'. Rode migração dos logs legados para ficar instantâneo.");
}

    // merge + dedupe (pode existir duplicado se você migrar/copiar)
    const seen = new Set();
    const merged = [];
    for (const item of [...unified, ...legacy]) {
        const k = `${item.uid || 'NA'}|${item.timestamp?.seconds || item.timestamp?.toMillis?.() || '0'}|${item.type || ''}|${item.reason || ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(item);
    }

    // ordena desc por timestamp
    merged.sort((a, b) => {
        const ta = a.timestamp?.seconds ? a.timestamp.seconds : (a.timestamp?.toMillis ? Math.floor(a.timestamp.toMillis()/1000) : 0);
        const tb = b.timestamp?.seconds ? b.timestamp.seconds : (b.timestamp?.toMillis ? Math.floor(b.timestamp.toMillis()/1000) : 0);
        return tb - ta;
    });

    return { logs: merged, startDate };
}

// --- LÓGICA DO DASHBOARD (CORE) ---
async function setupRealtimeDashboard(period) {
    console.log(`📡 Iniciando busca de logs. Período: ${period}`);
    if(tableBody) tableBody.style.opacity = '0.5';

    const selectedUid = userFilter ? userFilter.value : 'ALL';

    try {
        const { logs } = await fetchUnifiedLogs(period, selectedUid);
        console.log(`📊 Snapshot recebido: ${logs.length} documentos encontrados.`);
        globalRawLogs = logs;
        if(tableBody) tableBody.style.opacity = '1';
        filterAndRenderLogs();
    } catch (error) {
        console.error("❌ Erro ao carregar logs:", error);
        if(tableBody) tableBody.style.opacity = '1';
    }
}

async function populateUserFilter() {
    if (!userFilter) return;
    
    try {
        const snapshot = await db.collection('users').orderBy('displayName').get();
        userFilter.innerHTML = '<option value="ALL">Todos os Usuários</option>';
        
        snapshot.forEach(doc => {
            const data = doc.data();
            const option = document.createElement('option');
            option.value = doc.id; 
            option.textContent = data.displayName || data.email || doc.id;
            userFilter.appendChild(option);
        });
        console.log("👥 Filtro de usuários populado com sucesso.");
    } catch (error) {
        console.error("❌ Erro ao popular filtro de usuários:", error);
    }
}

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
    logs.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds);

    const criticalAlerts = logs.filter(l => 
        l.type === 'ALARM' && l.reason && (
            l.reason.includes('SONO PROFUNDO') || 
            l.reason.includes('PERIGO') || 
            l.reason.includes('CRÍTICO')
        )
    ).length;

    const microSleeps = logs.filter(l => l.type === 'ALARM' && l.reason && l.reason.includes('MICROSSONO')).length;
    const lunches = logs.filter(l => l.type === 'LUNCH_START').length;

    const uniqueUsers = new Set();
    logs.forEach(l => {
        if (l.uid) uniqueUsers.add(l.uid);
        else if (l.userName) uniqueUsers.add(l.userName);
    });
    
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
    const mergedLogs = mergeLunchEvents(logs);
    renderGroupedTable(mergedLogs);
    renderReports(logs);
}

// --- LÓGICA DE RELATÓRIOS (RANKING & HEATMAP) ---
function renderReports(logs) {
    if (!logs || logs.length === 0) return;

    if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'heatmap-tooltip';
        document.body.appendChild(tooltipEl);
    }

    const alarmLogs = logs.filter(l => l.type === 'ALARM');

    const userStats = {};
    const heatmapData = {}; 

    alarmLogs.forEach(log => {
        const uid = log.uid || 'anon';
        const name = log.userName || 'Desconhecido';
        
        if (!userStats[uid]) userStats[uid] = { name: name, count: 0, uid: uid };
        userStats[uid].count++;

        const hour = log.timestamp.toDate().getHours(); 
        if (!heatmapData[uid]) heatmapData[uid] = Array(24).fill(0);
        heatmapData[uid][hour]++;
    });

    const sortedUsers = Object.values(userStats).sort((a, b) => b.count - a.count);

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
                indexAxis: 'y', 
                responsive: true, 
                maintainAspectRatio: false,
                scales: { 
                    x: { 
                        grid: { color: 'rgba(255,255,255,0.05)' }, 
                        ticks: { color: '#8E8E93' } 
                    }, 
                    y: { 
                        display: true, 
                        grid: { display: false }, 
                        ticks: { 
                            color: '#fff', 
                            font: { size: 11, weight: '600' } 
                        } 
                    } 
                },
                plugins: { legend: { display: false } }
            }
        });
    }

    const heatmapContainer = document.getElementById('heatmap-container');
    if (heatmapContainer) {
        let html = '<div class="heatmap-grid">';
        html += '<div style="font-size:0.7rem; color:#888; text-align:right; padding-right:10px; align-self:end;">COLABORADOR</div>'; 
        for (let h = 0; h < 24; h++) {
            const hh = String(h).padStart(2, '0');
            html += `<div class="heatmap-header-cell">${hh}h</div>`;
        }
        html += '<div class="heatmap-header-cell">TTL</div>';

        const usersToRender = sortedUsers.slice(0, 10);
        
        if (usersToRender.length === 0) {
            html += '<div style="grid-column: 1/-1; padding:30px; text-align:center; color: var(--text-muted);">Nenhum dado térmico capturado hoje.</div>';
        } else {
            usersToRender.forEach(user => {
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
const hmModal = document.getElementById('heatmap-details-modal');
const hmTitle = document.getElementById('hm-modal-title');
const hmSubtitle = document.getElementById('hm-modal-subtitle');
const hmList = document.getElementById('hm-logs-list');
const btnCloseHm = document.getElementById('close-hm-modal');
const btnCloseHmFooter = document.getElementById('btn-close-hm-footer');

if(btnCloseHm) btnCloseHm.onclick = () => hmModal.classList.add('hidden');
if(btnCloseHmFooter) btnCloseHmFooter.onclick = () => hmModal.classList.add('hidden');

window.openHeatmapDetails = function(uid, name, hour) {
    if (!globalRawLogs || globalRawLogs.length === 0) return;

    const filtered = globalRawLogs.filter(log => {
        const logHour = log.timestamp.toDate().getHours();
        return log.uid === uid && logHour === hour && log.type === 'ALARM';
    });

    if (filtered.length === 0) return;

    const hourStr = String(hour).padStart(2, '0');
    if(hmTitle) hmTitle.innerText = `Incidentes: ${name}`;
    if(hmSubtitle) hmSubtitle.innerText = `Horário: ${hourStr}:00 às ${hourStr}:59 • Total: ${filtered.length} ocorrências`;

    if(hmList) {
        hmList.innerHTML = '';
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
    }

    if(hmModal) {
        hmModal.classList.remove('hidden');
        requestAnimationFrame(() => {
            hmModal.style.opacity = '1';
        });
    }
};

window.showTooltip = function(e, name, hour, count) {
    if(!tooltipEl || count === 0) return;
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
    const x = e.clientX + 15;
    const y = e.clientY + 15;
    tooltipEl.style.left = x + 'px';
    tooltipEl.style.top = y + 'px';
};

window.hideTooltip = function() {
    if(tooltipEl) tooltipEl.style.display = 'none';
};

// --- JUNÇÃO DE ALMOÇO ---
function mergeLunchEvents(rawLogs) {
    const combined = [];
    const activeLunches = new Map();

    const sortedAsc = [...rawLogs].sort((a, b) => a.timestamp.seconds - b.timestamp.seconds);

    sortedAsc.forEach(log => {
        if (log.type === 'LUNCH_START') {
            activeLunches.set(log.uid, log);
        } 
        else if (log.type === 'LUNCH_END') {
            const startLog = activeLunches.get(log.uid);
            
            if (startLog) {
                const start = startLog.timestamp.toDate();
                const end = log.timestamp.toDate();
                const diffMs = end - start;
                const minutes = Math.floor(diffMs / 60000);
                
                const timeStrStart = start.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                const timeStrEnd = end.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

                combined.push({
                    ...startLog, 
                    type: 'LUNCH_REPORT', 
                    timestamp: log.timestamp, 
                    reason: `Pausa Alimentar (${minutes} min)`, 
                    details: `Das ${timeStrStart} às ${timeStrEnd}` 
                });
                activeLunches.delete(log.uid);
            } else {
                combined.push(log); 
            }
        } 
        else {
            combined.push(log);
        }
    });

    activeLunches.forEach(log => {
        const start = log.timestamp.toDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        combined.push({
            ...log,
            type: 'LUNCH_ACTIVE',
            reason: 'Em Almoço',
            details: `Iniciado às ${start} (Em andamento)`
        });
    });

    return combined.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds);
}

// --- MÓDULO EQUIPE ---
export function initTeamModule() {
    setupTeamListener();
    setupInviteSystem();
    setupModalsTeam();
}

function setupTeamListener() {
    const teamGrid = document.getElementById('team-grid-container');
    if(!teamGrid) return;
    
    teamGrid.innerHTML = `
        <div class="tech-panel">
            <div class="tech-toolbar">
                <div style="position: relative; flex: 1;">
                    <span class="material-icons-round" style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-size: 18px;">search</span>
                    <input type="text" id="team-search" class="tech-input" style="padding-left: 40px; width: 100%;" placeholder="Buscar colaborador...">
                </div>
                
                <select id="team-role-filter" class="tech-input" style="width: 150px; cursor: pointer;">
                    <option value="ALL">Todos</option>
                    <option value="GUARD">Vigias</option>
                    <option value="ADMIN">Admins</option>
                    <option value="OWNER">Donos</option>
                </select>
            </div>

            <div id="tech-team-list" class="tech-list-container">
                <div style="padding: 40px; text-align: center; color: var(--text-muted);">
                    <span class="loader"></span> Carregando equipe...
                </div>
            </div>
        </div>
    `;

    // Ações do menu (3 pontos) - 1 listener só
    bindTeamActionsDelegation();

    const searchInput = document.getElementById('team-search');
    const roleFilter = document.getElementById('team-role-filter');

    const applyTeamFilters = () => {
        const term = searchInput.value.toLowerCase();
        const filterRole = roleFilter.value; 

        const filtered = localUsersList.filter(u => {
            let normalizedRole = 'GUARD';
            if (u.role === 'admin' || u.role === 'ADMIN') normalizedRole = 'ADMIN';
            if (u.role === 'dono' || u.role === 'OWNER') normalizedRole = 'OWNER';
            
            const matchText = (u.displayName && u.displayName.toLowerCase().includes(term)) || 
                              (u.email && u.email.toLowerCase().includes(term));
            
            const matchRole = (filterRole === 'ALL') || (normalizedRole === filterRole);

            return matchText && matchRole;
        });
        renderTeamList(filtered);
    };

    searchInput.addEventListener('input', applyTeamFilters);
    roleFilter.addEventListener('change', applyTeamFilters);

    if(unsubscribeTeam) unsubscribeTeam(); 

    unsubscribeTeam = db.collection('users').onSnapshot(snapshot => {
        localUsersList = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            localUsersList.push({ 
                uid: doc.id, 
                ...data,
                displayName: data.displayName || (data.email ? data.email.split('@')[0] : 'Sem Nome')
            });
        });

        const roleWeight = {
            'guard': 1, 'VIGIA': 1, 'vigia': 1,
            'admin': 2, 'ADMIN': 2,
            'dono': 3, 'OWNER': 3
        };

        localUsersList.sort((a, b) => {
            const weightA = roleWeight[a.role] || 1;
            const weightB = roleWeight[b.role] || 1;
            
            if (weightA !== weightB) return weightA - weightB; 
            return a.displayName.localeCompare(b.displayName);
        });

        applyTeamFilters(); 

    }, error => {
        console.error("Erro ao carregar equipe:", error);
        document.getElementById('tech-team-list').innerHTML = `<p style="text-align:center; color: var(--danger);">Erro ao carregar dados.</p>`;
    });
}


function bindTeamActionsDelegation() {
    const listEl = document.getElementById('tech-team-list');
    const confirmModal = document.getElementById('confirm-action-modal');
    const roleModal = document.getElementById('role-change-modal');
    if (!listEl) return;

    if (listEl.dataset.actionsBound === '1') return;
    listEl.dataset.actionsBound = '1';

    const closeAllMenus = () => {
        document.querySelectorAll('.team-actions-menu').forEach(m => m.classList.add('hidden'));
    };

    document.addEventListener('click', (e) => {
        const inside = e.target.closest('.team-actions-btn') || e.target.closest('.team-actions-menu');
        if (!inside) closeAllMenus();
    });

    listEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('.team-actions-btn');
        if (btn) {
        e.stopPropagation();
        const uid = btn.dataset.uid;
        const menu = document.querySelector(`.team-actions-menu[data-menu-for="${uid}"]`);
        
        const isOpen = !menu.classList.contains('hidden');
        closeAllMenus();
        
        if (!isOpen) {
            menu.classList.remove('hidden');
            // Garante que o menu não seja cortado pelo overflow do container
            menu.style.position = 'absolute';
            menu.style.right = '0';
            menu.style.top = '40px';
        }
        return;
    }

        const item = e.target.closest('.team-menu-item');
        if (!item) return;

        e.stopPropagation();
        const { action, uid } = item.dataset;
        const userName = item.closest('.tech-list-item').querySelector('span').innerText;

        // --- AÇÃO: VER LOGS ---
        if (action === 'view-logs') {
            const userFilter = document.getElementById('user-filter');
            if (userFilter) userFilter.value = uid;
            if (typeof filterAndRenderLogs === 'function') filterAndRenderLogs();
            const dashBtn = document.querySelector('.nav-btn[data-view="dashboard"]');
            if (dashBtn) dashBtn.click();
            closeAllMenus();
            return;
        }

        // --- AÇÃO: MUDAR ROLE (MODAL BONITO) ---
        if (action === 'set-role') {
            if (!window.isSystemOwner) return; 
            
            const select = document.getElementById('new-role-select');
            const btnSave = document.getElementById('btn-role-save');
            
            roleModal.classList.remove('hidden');
            setTimeout(() => roleModal.style.opacity = '1', 10);

            btnSave.onclick = async () => {
                const newRole = select.value;
                btnSave.disabled = true;
                btnSave.innerText = "Salvando...";
                try {
                    await db.collection('users').doc(uid).update({ role: newRole });
                    roleModal.style.opacity = '0';
                    setTimeout(() => roleModal.classList.add('hidden'), 300);
                } catch (err) {
                    console.error(err);
                } finally {
                    btnSave.disabled = false;
                    btnSave.innerText = "Salvar";
                }
            };

            document.getElementById('btn-role-cancel').onclick = () => {
                roleModal.style.opacity = '0';
                setTimeout(() => roleModal.classList.add('hidden'), 300);
            };
            closeAllMenus();
        }

        // --- AÇÃO: DESATIVAR/ATIVAR (MODAL DE CONFIRMAÇÃO) ---
        if (action === 'toggle-disabled') {
            if (!window.isSystemOwner) return;

            const ref = db.collection('users').doc(uid);
            const snap = await ref.get();
            const isDisabled = snap.exists ? !!snap.data().disabled : false;

            const confirmTitle = document.getElementById('confirm-title');
            const confirmDesc = document.getElementById('confirm-desc');
            const btnExec = document.getElementById('btn-confirm-execute');
            
            confirmTitle.innerText = isDisabled ? "Reativar Conta?" : "Desativar Conta?";
            confirmDesc.innerText = isDisabled 
                ? `O colaborador ${userName} voltará a ter acesso ao monitoramento.`
                : `O colaborador ${userName} será impedido de acessar o sistema imediatamente.`;
            
            btnExec.innerText = isDisabled ? "Reativar" : "Desativar";
            btnExec.style.background = isDisabled ? "var(--safe)" : "var(--danger)";

            confirmModal.classList.remove('hidden');
            setTimeout(() => confirmModal.style.opacity = '1', 10);

            btnExec.onclick = async () => {
                btnExec.disabled = true;
                try {
                    await ref.update({ disabled: !isDisabled });
                    confirmModal.style.opacity = '0';
                    setTimeout(() => confirmModal.classList.add('hidden'), 300);
                } catch (err) {
                    console.error(err);
                } finally {
                    btnExec.disabled = false;
                }
            };

            document.getElementById('btn-confirm-cancel').onclick = () => {
                confirmModal.style.opacity = '0';
                setTimeout(() => confirmModal.classList.add('hidden'), 300);
            };
            closeAllMenus();
        }
    });
}

function renderTeamList(users) {
    const container = document.getElementById('tech-team-list');
    if(!container) return;
    
    container.innerHTML = '';

    if (users.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding: 60px 20px; color: var(--text-muted);">
                <span class="material-icons-round" style="font-size: 48px; opacity:0.3; margin-bottom: 10px;">person_off</span>
                <p>Nenhum colaborador encontrado.</p>
            </div>`;
        return;
    }

    users.forEach(user => {
        const photo = user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName)}&background=333&color=fff`;
        
        let roleBadge = `<span class="badge-neon badge-user">VIGIA</span>`; 
        if(user.role === 'OWNER' || user.role === 'dono') roleBadge = `<span class="badge-neon badge-owner">DONO</span>`;
        else if(user.role === 'ADMIN' || user.role === 'admin') roleBadge = `<span class="badge-neon badge-admin">ADMIN</span>`;
        else if(user.role === 'VIGIA' || user.role === 'GUARD') roleBadge = `<span class="badge-neon badge-guard">VIGIA</span>`;

        const itemHtml = `
        <div class="tech-list-item">
            <div style="display: flex; align-items: center; gap: 16px; flex: 1;">
                <img src="${photo}" style="width: 42px; height: 42px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(255,255,255,0.1);">
                <div style="display: flex; flex-direction: column;">
                    <span style="font-weight: 600; font-size: 0.95rem; color: #fff;">${user.displayName}</span>
                    <span style="font-size: 0.75rem; color: var(--text-muted);">${user.email || '---'}</span>
                </div>
            </div>

            <div style="flex: 0 0 100px; text-align: center;">
                ${roleBadge}
            </div>
            
            <div style="display:flex; gap:8px; margin-left:15px; position:relative;">
                 <button
                   class="btn-icon-secondary team-actions-btn"
                   data-uid="${user.uid}"
                   data-name="${(user.displayName || '').replace(/"/g,'&quot;')}"
                   style="width:36px; height:36px; border-radius:8px; background:rgba(255,255,255,0.05); color:#fff; border:1px solid rgba(255,255,255,0.1); cursor:pointer; display:flex; align-items:center; justify-content:center;"
                   title="Ações"
                 >
                    <span class="material-icons-round" style="font-size: 20px;">more_horiz</span>
                 </button>

                 <div class="team-actions-menu hidden" data-menu-for="${user.uid}">
                    <button class="team-menu-item" data-action="view-logs" data-uid="${user.uid}">
                        <span class="material-icons-round" style="color: var(--primary);">analytics</span>
                        Ver Atividade
                    </button>

                    ${window.isSystemOwner ? `
                        <div class="menu-divider"></div>
                        
                        <button class="team-menu-item" data-action="set-role" data-uid="${user.uid}">
                            <span class="material-icons-round">manage_accounts</span>
                            Mudar Acesso
                        </button>

                        <button class="team-menu-item" data-action="toggle-disabled" data-uid="${user.uid}" style="color: #FF453A !important;">
                            <span class="material-icons-round">block</span>
                            ${user.disabled ? 'Reativar Conta' : 'Suspender Acesso'}
                        </button>
                    ` : ''}
                </div>
            </div>
        </div>
        `;
        container.innerHTML += itemHtml;
    });
}

function setupInviteSystem() {
    if (!formCreateInvite) return;

    formCreateInvite.addEventListener('submit', async (e) => {
        e.preventDefault();
        const role = document.getElementById('invite-role').value;
        const uses = parseInt(document.getElementById('invite-uses').value);
        const days = parseInt(document.getElementById('invite-days').value);
        const submitBtn = formCreateInvite.querySelector('button[type="submit"]');

        try {
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<span class="loader" style="width:18px; height:18px; border-width:2px;"></span> Gerando...`;
            
            const token = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + days);

            await db.collection('invites').doc(token).set({
                token, role, maxUses: uses, usesLeft: uses,
                expiresAt, createdBy: auth.currentUser.uid,
                createdAt: new Date(), active: true
            });

            const baseUrl = window.location.origin + window.location.pathname.replace('admin.html', 'index.html');
            const finalLink = `${baseUrl.split('?')[0]}?convite=${token}`;
            
            const msgTemplate = `💼 *Convite Oficial - SunDrowsy*\n\nVocê foi convidado a integrar a plataforma como *${role}*.\n\n📅 Expira em *${days} dia(s)*\n🔢 Válido para *${uses} uso(s)*\n\n*Clique no link abaixo para criar sua conta:*\n${finalLink}`;

            resultLinkInput.value = finalLink;
            resultMsgDiv.innerText = msgTemplate;

            // Transição elegante entre modais
            addMemberModal.style.opacity = '0';
            setTimeout(() => {
                addMemberModal.classList.add('hidden');
                inviteResultModal.classList.remove('hidden');
                setTimeout(() => inviteResultModal.style.opacity = '1', 50);
            }, 300);

            // Handlers de Cópia
            btnCopyLink.onclick = () => { navigator.clipboard.writeText(finalLink); toastSuccess('Link copiado!'); };
            btnCopyMsg.onclick = () => { navigator.clipboard.writeText(msgTemplate); toastSuccess('Mensagem copiada!'); };
            btnShareWpp.onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent(msgTemplate)}`, '_blank');

            formCreateInvite.reset();
        } catch (error) {
            console.error(error);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = "Gerar Link de Convite";
        }
    });
}

// Helper rápido para feedback visual (substitui o alert feio)
function toastSuccess(msg) {
    const toast = document.createElement('div');
    toast.style = "position:fixed; bottom:30px; left:50%; transform:translateX(-50%); background:var(--safe); color:#000; padding:12px 25px; border-radius:12px; font-weight:bold; z-index:10000; animation: floatUp 0.3s ease;";
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}

function setupModalsTeam() {
    if(btnAddMember) {
        btnAddMember.addEventListener('click', () => {
            addMemberModal.classList.remove('hidden');
            setTimeout(() => addMemberModal.style.opacity = '1', 10);
        });
    }

    [closeMemberModal, closeInviteResult].forEach(btn => {
        if(btn) btn.addEventListener('click', () => {
            if(addMemberModal) { addMemberModal.style.opacity = '0'; setTimeout(() => addMemberModal.classList.add('hidden'), 300); }
            if(inviteResultModal) { inviteResultModal.style.opacity = '0'; setTimeout(() => inviteResultModal.classList.add('hidden'), 300); }
        });
    });
}

function renderTeamCard(data, displayName) {
    const photo = data.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=random&color=fff&background=333`;
    const card = `
        <div class="team-card">
            <img src="${photo}" class="team-avatar">
            <h3 style="margin:0; font-size: 1rem;">${displayName}</h3>
            <p style="color:var(--text-muted); margin:5px 0 15px 0; font-size: 0.85rem;">${data.role || 'Usuário'}</p>
            <div style="font-size:0.8rem;">
                <span class="status-dot status-online"></span>
                <span style="color: var(--text-muted);">Ativo</span>
            </div>
            ${data.email ? `<small style="display:block; margin-top:10px; font-size:0.7rem; color:var(--text-muted); opacity: 0.7;">${data.email}</small>` : ''}
        </div>
    `;
    teamGrid.innerHTML += card;
}

// --- TABELA ---

function renderGroupedTable(logs) {
    if(!tableBody) return;
    tableBody.innerHTML = '';
    
    const tableHeader = document.querySelector('.logs-table-container thead tr');
    const isOwner = (currentUserRole === 'OWNER' && window.destroyerMode === true);

    if(tableHeader) {
        tableHeader.innerHTML = `
            <th style="width: 120px;">HORÁRIO</th>
            <th>COLABORADOR</th>
            <th>OCORRÊNCIA</th>
            <th style="text-align: right;">DETALHES / FOTO</th>
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

        const mainSnapshotBtn = (!isMultiple && lastLog.snapshot) ? `
            <button class="btn-icon-danger btn-view-snap" style="margin-right:8px; padding: 4px; vertical-align: middle; border: 1px solid rgba(255,208,40,0.3);" data-snap="${lastLog.snapshot}" title="Ver Foto">
                <span class="material-icons-round" style="color: var(--primary); font-size: 18px;">photo_camera</span>
            </button>
        ` : '';

        let actionHtml = '';
        if (lastLog.details) {
            actionHtml = `<div style="display:flex; align-items:center; justify-content: flex-end;">${mainSnapshotBtn}<span style="font-size: 0.85rem; color: var(--text-muted);">${lastLog.details}</span></div>`;
        } else if (isMultiple) {
            actionHtml = `<span class="material-icons-round" id="icon-group-${index}" style="color: var(--text-muted); transition: 0.3s;">expand_more</span>`;
        } else {
             actionHtml = mainSnapshotBtn || '';
        }

        const groupId = `group-${index}`;
        
        let deleteBtn = '';
        if (isOwner) {
            if (!isMultiple) {
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
                const snapshotBtn = item.snapshot ? `
                    <button class="btn-icon-danger btn-view-snap" style="margin-right:8px; padding: 4px;" data-snap="${item.snapshot}" title="Ver Foto">
                        <span class="material-icons-round" style="color: var(--primary); font-size: 16px;">photo_camera</span>
                    </button>
                ` : '';

                const itemDelete = isOwner ? `
                    <button class="btn-icon-danger" onclick="confirmDeleteOne('${item.uid}', '${item.dateFolder}', '${item.id}')" title="Apagar Item">
                        <span class="material-icons-round" style="font-size: 18px;">delete</span>
                    </button>
                ` : '';

                detailsHtml += `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                        <div style="display:flex; gap: 10px; align-items: center;">
                            <span style="font-family: monospace; color: var(--text-muted); font-size: 0.85rem;">${iTime}</span>
                            ${snapshotBtn} <span style="color: #fff; font-size: 0.9rem;">${desc}</span>
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

// --- DELEÇÃO ---
window.confirmDeleteOne = async function(uid, dateFolder, docId) {
    if(window.event) window.event.stopPropagation();

    if (!confirm("⚠️ ATENÇÃO: Deseja apagar este registro permanentemente?")) return;

    try {
        // Busca na subcoleção fixa 'logs'
        await db.collection('logs').doc(uid).collection('logs').doc(docId).delete();
        console.log("Log deletado.");
    } catch (error) {
        console.error("Erro ao deletar:", error);
        alert("Erro ao deletar: " + error.message);
    }
};

const btnWipe = document.getElementById('btn-wipe-logs');
const btnWipeText = document.getElementById('btn-wipe-text');

if (userFilter && btnWipeText) {
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
        let logsToDelete = (selectedUser === 'ALL') ? globalRawLogs : globalRawLogs.filter(l => l.uid === selectedUser);
        let confirmMsg = (selectedUser === 'ALL') ? "🚨 PERIGO EXTREMO: Apagar TUDO visível?" : "⚠️ Apagar registros do usuário?";

        if (logsToDelete.length === 0) return alert("Nada para deletar.");

        if (confirm(confirmMsg)) {
            if (selectedUser === 'ALL') {
                const check = prompt("Digite 'DELETAR' para confirmar:");
                if (check !== 'DELETAR') return;
            }

            btnWipe.disabled = true;
            btnWipe.innerText = "Deletando...";

            try {
                for (const log of logsToDelete) {
                    await db.collection('logs').doc(log.uid).collection('logs').doc(log.id).delete();
                }
                alert("Limpeza concluída.");
            } catch (error) {
                console.error(error);
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

// --- EXPORTAÇÃO CSV ---
const btnExportCsv = document.getElementById('btn-export-csv');
if (btnExportCsv) {
    btnExportCsv.addEventListener('click', exportLogsToCSV);
}

function exportLogsToCSV() {
    if (!globalRawLogs || globalRawLogs.length === 0) return alert("Sem dados.");
    const selectedUser = userFilter.value;
    let dataToExport = (selectedUser === 'ALL') ? [...globalRawLogs] : globalRawLogs.filter(log => log.uid === selectedUser);
    dataToExport.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds);

    const headers = ['DATA', 'HORA', 'NOME', 'CARGO', 'TIPO EVENTO', 'MOTIVO/DESCRIÇÃO', 'DETALHES EXTRAS'];
    const csvRows = dataToExport.map(log => {
        const dateObj = log.timestamp.toDate();
        const clean = (text) => text ? `"${text.toString().replace(/"/g, '""')}"` : "";
        return [
            dateObj.toLocaleDateString('pt-BR'),
            dateObj.toLocaleTimeString('pt-BR'),
            clean(log.userName || 'Desconhecido'),
            clean(log.role || '--'),
            clean(log.type),
            clean(log.reason || log.description || ''),
            clean(log.fatigue_level ? `Nível: ${log.fatigue_level}` : "")
        ].join(',');
    });

    const csvContent = '\uFEFF' + [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `SunDrowsy_Relatorio_${new Date().toLocaleDateString('pt-BR')}.csv`;
    link.click();
}

// Snapshots Viewer
document.addEventListener('click', function(e) {
    const btn = e.target.closest('.btn-view-snap');
    if (btn) {
        const imageData = btn.getAttribute('data-snap');
        const win = window.open("");
        win.document.write(`<html><body style="margin:0;background:#000;display:flex;justify-content:center;align-items:center;height:100vh;"><img src="${imageData}" style="max-width:100%;max-height:100%;border:2px solid #FFD028;"></body></html>`);
    }
});

// ESC & Outside Modals
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal:not(.hidden)').forEach(modal => {
            modal.style.opacity = '0';
            setTimeout(() => modal.classList.add('hidden'), 300);
        });
    }
});

window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.style.opacity = '0';
        setTimeout(() => e.target.classList.add('hidden'), 300);
    }
});