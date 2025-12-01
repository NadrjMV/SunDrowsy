import { auth, db, googleProvider } from './firebase-config.js';

const kpiAlerts = document.getElementById('kpi-alerts');
const kpiMicrosleeps = document.getElementById('kpi-microsleeps');
const kpiLunches = document.getElementById('kpi-lunches');
const kpiActiveUsers = document.getElementById('kpi-active-users');

const tableBody = document.getElementById('logs-table-body');
const periodFilter = document.getElementById('period-filter');
const teamGrid = document.getElementById('team-grid-container');

const navBtns = document.querySelectorAll('.nav-btn[data-view]');
const views = document.querySelectorAll('.admin-view');

const btnAddMember = document.getElementById('btn-add-member');
const addMemberModal = document.getElementById('add-member-modal');
const closeMemberModal = document.getElementById('close-add-member');
const formAddMember = document.getElementById('form-add-member');

let charts = {}; 
let unsubscribeLogs = null;
let unsubscribeTeam = null;

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
        const adminPhoto = document.getElementById('admin-photo');
        if(adminPhoto) adminPhoto.src = user.photoURL;
        
        setupRealtimeDashboard('today');
        setupTeamListener();

    } catch (error) {
        console.error("Erro de permissão:", error);
        window.location.href = 'index.html';
    }
});

navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        navBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const viewId = btn.getAttribute('data-view');
        views.forEach(v => v.classList.remove('active'));
        const view = document.getElementById(`view-${viewId}`);
        if(view) view.classList.add('active');
    });
});

if(periodFilter) {
    periodFilter.addEventListener('change', (e) => {
        if (unsubscribeLogs) unsubscribeLogs();
        setupRealtimeDashboard(e.target.value);
    });
}

function setupRealtimeDashboard(period) {
    console.log(`📡 Conectando stream: ${period}`);
    if(tableBody) tableBody.style.opacity = '0.5';

    const now = new Date();
    const todayFolder = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    
    let query;
    try {
        query = db.collectionGroup(todayFolder);
    } catch (e) {
        query = db.collection('logs').doc(auth.currentUser.uid).collection(todayFolder);
    }

    unsubscribeLogs = query.onSnapshot((snapshot) => {
        const logs = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            const uidFromPath = doc.ref.parent.parent ? doc.ref.parent.parent.id : null;
            logs.push({ ...data, uid: uidFromPath || data.uid });
        });
        
        if(tableBody) tableBody.style.opacity = '1';
        processLogs(logs);
    }, (error) => {
        console.error("Erro Stream Logs:", error);
    });
}

function processLogs(logs) {
    logs.sort((a, b) => b.timestamp.seconds - a.timestamp.seconds);

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
    if(!tableBody) return;
    tableBody.innerHTML = '';
    
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

function exportLogsToCSV() {
    const rows = [['Horário', 'Colaborador', 'Função', 'Tipo', 'Detalhes']];
    document.querySelectorAll('#logs-table-body tr:not([id])').forEach(row => {
        const cells = row.querySelectorAll('td');
        if(cells.length > 0) {
            rows.push([
                cells[0].innerText,
                cells[1].innerText.split('\n')[0],
                cells[1].innerText.split('\n')[1],
                cells[2].innerText,
                ''
            ]);
        }
    });
    
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio-fadiga-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
}

function setupTeamListener() {
    if(!teamGrid) return;
    unsubscribeTeam = db.collection('users').onSnapshot(snapshot => {
        teamGrid.innerHTML = ''; 

        if (snapshot.empty) {
            teamGrid.innerHTML = '<p style="color:var(--text-muted); width:100%; padding:20px;">Nenhum membro encontrado. Adicione alguém!</p>';
            return;
        }

        snapshot.forEach(doc => {
            const data = doc.data();
            const displayName = data.displayName || (data.email ? data.email.split('@')[0] : 'Sem Nome');
            const photo = data.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=random&color=fff&background=333`;
            const isOnline = true; 

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
        });
    }, error => {
        console.error("Erro ao carregar equipe:", error);
        teamGrid.innerHTML = '<div style="color: var(--danger);">Erro ao carregar dados.</div>';
    });
}

if(btnAddMember) {
    btnAddMember.style.display = 'flex'; 
    btnAddMember.addEventListener('click', () => {
        if(addMemberModal) {
            addMemberModal.classList.remove('hidden');
            setTimeout(() => addMemberModal.style.opacity = '1', 10);
        }
    });
}

if(closeMemberModal) {
    closeMemberModal.addEventListener('click', () => {
        if(addMemberModal) {
            addMemberModal.style.opacity = '0';
            setTimeout(() => addMemberModal.classList.add('hidden'), 300);
        }
    });
}

if(formAddMember) {
    formAddMember.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const name = document.getElementById('new-user-name').value;
        const email = document.getElementById('new-user-email').value;
        const role = document.getElementById('new-user-role').value;
        const submitBtn = formAddMember.querySelector('button[type="submit"]');

        if(!name || !email) return alert("Preencha todos os campos!");

        try {
            submitBtn.disabled = true;
            submitBtn.innerText = "Salvando...";

            await db.collection('users').add({
                displayName: name,
                email: email,
                role: role,
                createdAt: new Date(),
                photoURL: null, 
                active: true
            });

            alert(`✅ ${name} pré-cadastrado com sucesso!`);
            
            formAddMember.reset();
            addMemberModal.style.opacity = '0';
            setTimeout(() => addMemberModal.classList.add('hidden'), 300);

        } catch (error) {
            console.error("Erro ao adicionar:", error);
            alert("Erro ao salvar: " + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = "Salvar Cadastro";
        }
    });
}