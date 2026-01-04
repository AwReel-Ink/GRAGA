// ==================== Configuration IndexedDB ====================
const DB_NAME = 'GrattageTrackerDB';
const DB_VERSION = 1;
let db;

// Initialisation de la base de données
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;

            // Store pour les jeux
            if (!database.objectStoreNames.contains('games')) {
                const gamesStore = database.createObjectStore('games', { keyPath: 'id', autoIncrement: true });
                gamesStore.createIndex('name', 'name', { unique: true });
            }

            // Store pour les tickets
            if (!database.objectStoreNames.contains('tickets')) {
                const ticketsStore = database.createObjectStore('tickets', { keyPath: 'id', autoIncrement: true });
                ticketsStore.createIndex('gameId', 'gameId', { unique: false });
            }
        };
    });
}

// ==================== Opérations CRUD ====================

// Récupérer tous les jeux
async function getAllGames() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['games'], 'readonly');
        const store = transaction.objectStore('games');
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Ajouter un jeu
async function addGame(game) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['games'], 'readwrite');
        const store = transaction.objectStore('games');
        const request = store.add(game);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Supprimer un jeu
async function deleteGame(gameId) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['games', 'tickets'], 'readwrite');
        
        // Supprimer le jeu
        const gamesStore = transaction.objectStore('games');
        gamesStore.delete(gameId);

        // Supprimer les tickets associés
        const ticketsStore = transaction.objectStore('tickets');
        const index = ticketsStore.index('gameId');
        const request = index.openCursor(IDBKeyRange.only(gameId));

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

// Récupérer les tickets d'un jeu
async function getTicketsByGame(gameId) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['tickets'], 'readonly');
        const store = transaction.objectStore('tickets');
        const index = store.index('gameId');
        const request = index.getAll(gameId);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Ajouter des tickets
async function addTickets(tickets) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['tickets'], 'readwrite');
        const store = transaction.objectStore('tickets');

        tickets.forEach(ticket => store.add(ticket));

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

// Récupérer tous les tickets
async function getAllTickets() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['tickets'], 'readonly');
        const store = transaction.objectStore('tickets');
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Réinitialiser toutes les données
async function resetAllData() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['games', 'tickets'], 'readwrite');
        
        transaction.objectStore('games').clear();
        transaction.objectStore('tickets').clear();

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

// ==================== Variables Globales ====================
let currentGameId = null;
let newTicketsToAdd = [];

// ==================== Navigation ====================
function showPage(pageId) {
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    document.getElementById(pageId).classList.add('active');
}

function goHome() {
    showPage('home-page');
    newTicketsToAdd = [];
    loadHomePage();
}

function showAddGame() {
    showPage('add-game-page');
    document.getElementById('add-game-form').reset();
}

function showSettings() {
    showPage('settings-page');
    loadSettingsStats();
}

async function showGameDetail(gameId) {
    currentGameId = gameId;
    showPage('game-detail-page');
    await loadGameDetail();
}

// ==================== Page d'Accueil ====================
async function loadHomePage() {
    const games = await getAllGames();
    const allTickets = await getAllTickets();

    // Trier les jeux par nom
    games.sort((a, b) => a.name.localeCompare(b.name));

    // Calculer les statistiques globales
    let totalGains = 0;
    let totalSpent = 0;
    const gameStats = [];

    for (const game of games) {
        const gameTickets = allTickets.filter(t => t.gameId === game.id);
        const gameGains = gameTickets.reduce((sum, t) => sum + t.gain, 0);
        const gameCost = gameTickets.length * game.ticketPrice;
        const profit = gameGains - gameCost;

        totalGains += gameGains;
        totalSpent += gameCost;

        gameStats.push({
            ...game,
            ticketCount: gameTickets.length,
            totalGains: gameGains,
            totalCost: gameCost,
            profit: profit,
            avgGain: gameTickets.length > 0 ? gameGains / gameTickets.length : 0
        });
    }

    // Mettre à jour les bulles de stats
    document.getElementById('total-gains').textContent = formatCurrency(totalGains);
    document.getElementById('total-spent').textContent = formatCurrency(totalSpent);

    // Meilleur et pire jeu (basé sur le profit)
    const gamesWithTickets = gameStats.filter(g => g.ticketCount > 0);
    
    if (gamesWithTickets.length > 0) {
        const bestGame = gamesWithTickets.reduce((a, b) => a.profit > b.profit ? a : b);
        const worstGame = gamesWithTickets.reduce((a, b) => a.profit < b.profit ? a : b);

        document.getElementById('best-game').textContent = `${bestGame.name} (${formatCurrency(bestGame.profit)})`;
        document.getElementById('worst-game').textContent = `${worstGame.name} (${formatCurrency(worstGame.profit)})`;
    } else {
        document.getElementById('best-game').textContent = '-';
        document.getElementById('worst-game').textContent = '-';
    }

    // Afficher la liste des jeux
    const gamesList = document.getElementById('games-list');

    if (games.length === 0) {
        gamesList.innerHTML = '<p class="empty-state">Aucun jeu enregistré.<br>Cliquez sur ➕ pour ajouter un jeu.</p>';
        return;
    }

    gamesList.innerHTML = gameStats.map(game => `
        <div class="game-card" onclick="showGameDetail(${game.id})">
            <div class="game-name">${escapeHtml(game.name)}</div>
            <div class="game-stat">
                <span class="game-stat-label">Gain moyen</span>
                <span class="game-stat-value ${game.avgGain >= game.ticketPrice ? 'positive' : 'negative'}">
                    ${formatCurrency(game.avgGain)}
                </span>
            </div>
            <div class="game-stat">
                <span class="game-stat-label">Dépensé</span>
                <span class="game-stat-value">${formatCurrency(game.totalCost)}</span>
            </div>
        </div>
    `).join('');
}

// ==================== Ajout de Jeu ====================
document.getElementById('add-game-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('game-name').value.trim();
    const ticketPrice = parseFloat(document.getElementById('ticket-price').value);

    if (!name || isNaN(ticketPrice) || ticketPrice <= 0) {
        alert('Veuillez remplir tous les champs correctement.');
        return;
    }

    try {
        await addGame({
            name: name,
            ticketPrice: ticketPrice,
            createdAt: new Date().toISOString()
        });
        goHome();
    } catch (error) {
        if (error.name === 'ConstraintError') {
            alert('Un jeu avec ce nom existe déjà.');
        } else {
            alert('Erreur lors de l\'ajout du jeu.');
            console.error(error);
        }
    }
});

// ==================== Détail du Jeu ====================
async function loadGameDetail() {
    const games = await getAllGames();
    const game = games.find(g => g.id === currentGameId);

    if (!game) {
        goHome();
        return;
    }

    document.getElementById('detail-game-name').textContent = game.name;

    const tickets = await getTicketsByGame(currentGameId);
    const totalGains = tickets.reduce((sum, t) => sum + t.gain, 0);
    const totalCost = tickets.length * game.ticketPrice;
    const avgGain = tickets.length > 0 ? totalGains / tickets.length : 0;
    const ratio = totalCost > 0 ? (totalGains / totalCost) * 100 : 0;

    document.getElementById('detail-tickets-count').textContent = tickets.length;
    document.getElementById('detail-total-cost').textContent = formatCurrency(totalCost);
    document.getElementById('detail-total-gains').textContent = formatCurrency(totalGains);
    document.getElementById('detail-avg-gain').textContent = formatCurrency(avgGain);
    document.getElementById('detail-ratio').textContent = ratio.toFixed(1) + '%';

    // Afficher les tickets existants
    const ticketsContainer = document.getElementById('tickets-container');
    
    if (tickets.length === 0) {
        ticketsContainer.innerHTML = '<p class="empty-state">Aucun ticket.<br>Cliquez sur ➕ pour ajouter un ticket.</p>';
    } else {
        ticketsContainer.innerHTML = tickets.map((ticket, index) => `
            <div class="ticket-row">
                <div class="ticket-number">${index + 1}</div>
                <div>Ticket #${index + 1}</div>
                <div class="ticket-gain ${ticket.gain > 0 ? 'positive' : 'zero'}">
                    ${formatCurrency(ticket.gain)}
                </div>
            </div>
        `).join('');
    }

    // Réinitialiser les nouveaux tickets
    newTicketsToAdd = [];
    renderNewTickets();
}

function addTicketRow() {
    newTicketsToAdd.push({ gain: 0 });
    renderNewTickets();
}

function removeNewTicket(index) {
    newTicketsToAdd.splice(index, 1);
    renderNewTickets();
}

function updateNewTicketGain(index, value) {
    newTicketsToAdd[index].gain = parseFloat(value) || 0;
}

function renderNewTickets() {
    const container = document.getElementById('new-tickets-container');
    const saveBtn = document.getElementById('save-tickets-btn');

    if (newTicketsToAdd.length === 0) {
        container.innerHTML = '';
        saveBtn.classList.add('hidden');
        return;
    }

    saveBtn.classList.remove('hidden');

    container.innerHTML = newTicketsToAdd.map((ticket, index) => `
        <div class="new-ticket-row">
            <div class="ticket-number">+</div>
            <input type="number" 
                   step="0.5" 
                   min="0" 
                   placeholder="Gain (€)" 
                   value="${ticket.gain || ''}"
                   onchange="updateNewTicketGain(${index}, this.value)"
                   oninput="updateNewTicketGain(${index}, this.value)">
            <button class="remove-ticket-btn" onclick="removeNewTicket(${index})">−</button>
        </div>
    `).join('');
}

async function saveNewTickets() {
    if (newTicketsToAdd.length === 0) return;

    const tickets = newTicketsToAdd.map(t => ({
        gameId: currentGameId,
        gain: t.gain || 0,
        createdAt: new Date().toISOString()
    }));

    try {
        await addTickets(tickets);
        newTicketsToAdd = [];
        await loadGameDetail();
    } catch (error) {
        alert('Erreur lors de l\'enregistrement des tickets.');
        console.error(error);
    }
}

// ==================== Suppression ====================
function confirmDeleteGame() {
    showModal(
        'Supprimer le jeu',
        'Êtes-vous sûr de vouloir supprimer ce jeu et tous ses tickets ?',
        async () => {
            await deleteGame(currentGameId);
            closeModal();
            goHome();
        }
    );
}

function confirmResetAll() {
    showModal(
        'Réinitialiser',
        'Êtes-vous sûr de vouloir supprimer TOUTES les données ? Cette action est irréversible.',
        async () => {
            await resetAllData();
            closeModal();
            goHome();
        }
    );
}

// ==================== Paramètres ====================
async function loadSettingsStats() {
    const games = await getAllGames();
    const tickets = await getAllTickets();
    const winningTickets = tickets.filter(t => t.gain > 0);

    document.getElementById('stats-total-games').textContent = games.length;
    document.getElementById('stats-total-tickets').textContent = tickets.length;
    document.getElementById('stats-winning-tickets').textContent = winningTickets.length;
}

// ==================== Modal ====================
function showModal(title, message, onConfirm) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-message').textContent = message;
    document.getElementById('modal').classList.remove('hidden');
    
    const confirmBtn = document.getElementById('modal-confirm');
    confirmBtn.onclick = onConfirm;
}

function closeModal() {
    document.getElementById('modal').classList.add('hidden');
}

// ==================== Utilitaires ====================
function formatCurrency(value) {
    return new Intl.NumberFormat('fr-FR', {
        style: 'currency',
        currency: 'EUR'
    }).format(value);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==================== Service Worker & PWA ====================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('Service Worker enregistré'))
            .catch(err => console.log('Erreur SW:', err));
    });
}

// ==================== Initialisation ====================
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initDB();
        await loadHomePage();
    } catch (error) {
        console.error('Erreur d\'initialisation:', error);
        alert('Erreur lors du chargement de l\'application.');
    }
});
