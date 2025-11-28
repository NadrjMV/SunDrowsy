import { auth, db, googleProvider } from './firebase-config.js';

// Elementos
const kpiAlerts = document.getElementById('kpi-alerts');
const kpiMicrosleeps = document.getElementById('kpi-microsleeps');
const kpiLunches = document.getElementById('kpi-lunches');
const kpiActiveUsers = document.getElementById('kpi-active-users');
const tableBody = document.getElementById('logs-table-body');
const periodFilter = document.getElementById('period-filter');
const teamGrid = document.getElementById('team-grid-container');

// Navegação
const navBtns = document.querySelectorAll('.nav-btn[data-view]');
const views = document.querySelectorAll('.admin-view');

let charts = {}; 
let unsubscribeLogs = null;

// --- AUTH CHECK & ROLE DETECTOR ---
auth.onAuthStateChanged(async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    
    // VERIFICAÇÃO DE ROLE (ADMIN/OWNER)
    try {
        const userDoc = await db.collection('users').doc(user.uid).get();
        const role = userDoc.exists ? userDoc.data().role : 'USER';
        
        // Permite apenas ADMIN ou OWNER. Você pode adicionar seu próprio UID aqui para bypass se precisar.
        if (role !== 'ADMIN' && role !== 'OWNER') {
            alert("⛔ Acesso Negado: Apenas administradores.");
            window.location.href = 'index.html';
            return;
        }

        console.log(`🔓 Admin logado: ${role}`);
        const adminPhoto = document.getElementById('admin-photo');
        if(adminPhoto) adminPhoto.src = user.photoURL;
        
        // Inicia Dashboard e carrega a Equipe
        setupRealtimeDashboard('today');
        renderTeamView();

    } catch (error) {
        console.error("Erro de permissão:", error);
        window.location.href = 'index.html';
    }
});

// --- NAVEGAÇÃO DE ABAS ---
navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        // Atualiza Botões
        navBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Atualiza Views
        const viewId = btn.getAttribute('data-view');
        views.forEach(v => v.classList.remove('active'));
        const view = document.getElementById(`view-${viewId}`);
        if(view) view.classList.add('active');
    });
});

// --- LISTENER DE FILTRO ---
if(periodFilter) {
    periodFilter.addEventListener('change', (e) => {
        if (unsubscribeLogs) unsubscribeLogs();
        setupRealtimeDashboard(e.target.value);
    });
}

function setupRealtimeDashboard(period) {
    console.log(`📡 Conectando stream: ${period}`);
    tableBody.style.opacity = '0.5';

    const now = new Date();
    const todayFolder = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    
    let query;
    try {
        // Tenta conectar no "Collection Group" (Global)
        query = db.collectionGroup(todayFolder);
    } catch (e) {
        console.warn("⚠️ Fallback: Monitorando apenas usuário local.");
        query = db.collection('logs').doc(auth.currentUser.uid).collection(todayFolder);
    }

    unsubscribeLogs = query.onSnapshot((snapshot) => {
        const logs = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            const uidFromPath = doc.ref.parent.parent ? doc.ref.parent.parent.id : null;
            logs.push({ ...data, uid: uidFromPath || data.uid });
        });
        tableBody.style.opacity = '1';
        processLogs(logs);
    }, (error) => {
        console.error("Erro Stream:", error);
    });
}

function processLogs(logs) {
    logs.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds);

    // KPIs
    const criticalAlerts = logs.filter(l => l.type === 'ALARM' && l.reason && l.reason.includes('SONO PROFUNDO')).length;
    const microSleeps = logs.filter(l => l.type === 'ALARM' && l.reason && l.reason.includes('MICROSSONO')).length;
    const lunches = logs.filter(l => l.type === 'LUNCH_START').length;

    const uniqueUsers = new Set();
    logs.forEach(l => {
        if (l.uid) uniqueUsers.add(l.uid);
        else if (l.userName) uniqueUsers.add(l.userName);
    });
    if (auth.currentUser) uniqueUsers.add(auth.currentUser.uid);
    const activeCount = uniqueUsers.size;

    animateValue(kpiAlerts, criticalAlerts);
    animateValue(kpiMicrosleeps, microSleeps);
    animateValue(kpiLunches, lunches);
    
    if(kpiActiveUsers) {
        kpiActiveUsers.innerText = activeCount;
        const small = kpiActiveUsers.nextElementSibling;
        if(small) small.innerText = activeCount === 1 ? "Apenas você online" : `${activeCount} usuários hoje`;
    }

    renderCharts(logs);

    const sleepLogs = logs.filter(l => l.type === 'ALARM');
    renderGroupedTable(sleepLogs);
}

function renderGroupedTable(logs) {
    tableBody.innerHTML = '';
    
    // Cabeçalho simplificado como pedido
    const tableHeader = document.querySelector('.logs-table-container thead tr');
    if(tableHeader) {
        tableHeader.innerHTML = `
            <th style="width: 120px;">HORÁRIO</th>
            <th>COLABORADOR</th>
            <th>OCORRÊNCIA</th>
            <th style="text-align: right;">AÇÃO</th>
        `;
    }

    if (logs.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: var(--text-muted); padding: 30px;">
            <span class="material-icons-round" style="font-size: 24px; vertical-align: middle; margin-right: 8px;">check_circle</span>
            Nenhum incidente de fadiga registrado agora.
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
                userName: log.userName || auth.currentUser.displayName || 'Usuário',
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
        
        let summaryText = isMultiple ? `<span style="color: #fff; font-weight: bold;">${group.items.length} Alertas Seguidos</span>` : (lastLog.reason || "Fadiga Detectada");
        const groupId = `group-${index}`;

        const mainRow = `
            <tr class="group-header" onclick="toggleGroup('${groupId}')" style="cursor: pointer;">
                <td style="font-family: monospace; color: var(--primary);">
                    ${time} ${isMultiple ? '<span style="font-size:10px; opacity:0.7"> (último)</span>' : ''}
                </td>
                <td>
                    <div style="display: flex; flex-direction: column;">
                        <span style="font-weight: 600;">${group.userName}</span>
                        <span style="font-size: 0.75rem; color: var(--text-muted);">${group.role}</span>
                    </div>
                </td>
                <td><span class="badge bg-danger">${summaryText}</span></td>
                <td style="text-align: right;">
                    ${isMultiple ? `<span class="material-icons-round" id="icon-${groupId}" style="color: var(--text-muted); transition: 0.3s;">expand_more</span>` : ''}
                </td>
            </tr>
        `;
        tableBody.innerHTML += mainRow;

        if (isMultiple) {
            let detailsHtml = '';
            group.items.forEach(item => {
                const iTime = item.timestamp.toDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                detailsHtml += `
                    <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                        <span style="font-family: monospace; color: var(--text-muted); font-size: 0.85rem;">${iTime}</span>
                        <span style="color: #fff; font-size: 0.9rem;">${item.reason}</span>
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

// SIMULAÇÃO DA EQUIPE (Visual)
function renderTeamView() {
    if(!teamGrid) return;
    const mockTeam = [
        { name: auth.currentUser?.displayName || "Você", role: "Admin", status: "online", img: auth.currentUser?.photoURL || "" },
        { name: "Carlos Silva", role: "Motorista", status: "online", img: "https://ui-avatars.com/api/?name=Carlos+Silva&background=random" },
        { name: "Ana Souza", role: "Vigia", status: "offline", img: "https://ui-avatars.com/api/?name=Ana+Souza&background=random" }
    ];

    teamGrid.innerHTML = mockTeam.map(m => `
        <div class="team-card">
            <img src="${m.img}" class="team-avatar">
            <h3 style="margin:0;">${m.name}</h3>
            <p style="color:var(--text-muted); margin:5px 0 15px 0;">${m.role}</p>
            <div style="font-size:0.8rem;">
                <span class="status-dot ${m.status === 'online' ? 'status-online' : ''}" style="background:${m.status==='online'?'var(--safe)':'#555'}"></span>
                ${m.status === 'online' ? 'Monitorando Agora' : 'Offline'}
            </div>
        </div>
    `).join('');
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
        'Almoço': logs.filter(l => l.type.includes('LUNCH')).length
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