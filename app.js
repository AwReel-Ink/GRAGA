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

// Mettre à jour un ticket
async function updateTicket(ticket) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['tickets'], 'readwrite');
        const store = transaction.objectStore('tickets');
        const request = store.put(ticket);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Supprimer un ticket spécifique
async function deleteTicket(ticketId) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['tickets'], 'readwrite');
        const store = transaction.objectStore('tickets');
        const request = store.delete(ticketId);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
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
let currentGame = null;
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

    currentGame = game; // Stocker le jeu actuel
    document.getElementById('detail-game-name').textContent = game.name;

    const tickets = await getTicketsByGame(currentGameId);
    
    // Séparer les tickets avec gain défini et en attente
    const definedTickets = tickets.filter(t => t.gain !== null && t.gain !== undefined);
    const pendingTickets = tickets.filter(t => t.gain === null || t.gain === undefined);
    
    const totalGains = definedTickets.reduce((sum, t) => sum + t.gain, 0);
    const totalCost = tickets.length * game.ticketPrice;
    const avgGain = definedTickets.length > 0 ? totalGains / definedTickets.length : 0;
    const ratio = totalCost > 0 ? (totalGains / totalCost) * 100 : 0;

    document.getElementById('detail-tickets-count').textContent = tickets.length;
    document.getElementById('detail-total-cost').textContent = formatCurrency(totalCost);
    document.getElementById('detail-total-gains').textContent = formatCurrency(totalGains);
    document.getElementById('detail-avg-gain').textContent = formatCurrency(avgGain);
    document.getElementById('detail-ratio').textContent = ratio.toFixed(1) + '%';
    
    // Afficher le nombre de tickets en attente
    const pendingCountEl = document.getElementById('detail-pending-count');
    if (pendingCountEl) {
        if (pendingTickets.length > 0) {
            pendingCountEl.textContent = `(${pendingTickets.length} en attente)`;
            pendingCountEl.classList.remove('hidden');
        } else {
            pendingCountEl.classList.add('hidden');
        }
    }

    // Afficher les tickets existants (cliquables pour modification)
    const ticketsContainer = document.getElementById('tickets-container');

    if (tickets.length === 0 && newTicketsToAdd.length === 0) {
        ticketsContainer.innerHTML = '<p class="empty-state">Aucun ticket.<br>Cliquez sur ➕ pour ajouter un ticket.</p>';
    } else {
        // Trier : tickets en attente d'abord, puis par date
        const sortedTickets = [...tickets].sort((a, b) => {
            const aPending = a.gain === null || a.gain === undefined;
            const bPending = b.gain === null || b.gain === undefined;
            if (aPending && !bPending) return -1;
            if (!aPending && bPending) return 1;
            return new Date(b.createdAt) - new Date(a.createdAt);
        });

        ticketsContainer.innerHTML = sortedTickets.map((ticket, index) => {
            const isPending = ticket.gain === null || ticket.gain === undefined;
            const gainClass = isPending ? 'pending' : (ticket.gain > 0 ? 'positive' : 'zero');
            const gainText = isPending ? 'À gratter' : formatCurrency(ticket.gain);
            
            return `
                <div class="ticket-row clickable" onclick="openEditTicketModal(${ticket.id})">
                    <div class="ticket-number">${index + 1}</div>
                    <div class="ticket-label">Ticket #${index + 1}</div>
                    <div class="ticket-gain ${gainClass}">
                        ${gainText}
                    </div>
                    <div class="ticket-edit-icon">✏️</div>
                </div>
            `;
        }).join('');
    }

    // Réinitialiser les nouveaux tickets
    newTicketsToAdd = [];
    renderNewTickets();
}

// Ouvrir la modal d'édition d'un ticket existant
async function openEditTicketModal(ticketId) {
    const tickets = await getTicketsByGame(currentGameId);
    const ticket = tickets.find(t => t.id === ticketId);
    
    if (!ticket) return;
    
    const currentGain = (ticket.gain !== null && ticket.gain !== undefined) ? ticket.gain : '';
    
    const modalHtml = `
        <div id="edit-ticket-modal" class="modal">
            <div class="modal-overlay" onclick="closeEditTicketModal()"></div>
            <div class="modal-content edit-modal">
                <h2>Modifier le ticket</h2>
                <div class="edit-form">
                    <label for="edit-ticket-gain">Gain obtenu (€)</label>
                    <input type="number" 
                           id="edit-ticket-gain" 
                           step="0.5" 
                           min="0" 
                           placeholder="Laisser vide si pas encore gratté"
                           value="${currentGain}">
                    
                    <div class="quick-gains">
                        <span class="quick-label">Gains rapides :</span>
                        <div class="quick-buttons">
                            <button type="button" class="quick-btn" onclick="setQuickGain(0)">0€</button>
                            <button type="button" class="quick-btn" onclick="setQuickGain(2)">2€</button>
                            <button type="button" class="quick-btn" onclick="setQuickGain(5)">5€</button>
                            <button type="button" class="quick-btn" onclick="setQuickGain(10)">10€</button>
                            <button type="button" class="quick-btn" onclick="setQuickGain(20)">20€</button>
                            <button type="button" class="quick-btn" onclick="setQuickGain(50)">50€</button>
                            <button type="button" class="quick-btn" onclick="setQuickGain(100)">100€</button>
                        </div>
                    </div>
                </div>
                
                <div class="modal-actions">
                    <button class="btn btn-outline" onclick="closeEditTicketModal()">Annuler</button>
                    <button class="btn btn-danger-outline" onclick="deleteTicketConfirm(${ticketId})">Supprimer</button>
                    <button class="btn btn-primary" onclick="saveTicketEdit(${ticketId})">Enregistrer</button>
                </div>
            </div>
        </div>
    `;
    
    // Supprimer une éventuelle modal existante
    const existingModal = document.getElementById('edit-ticket-modal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Focus sur l'input
    setTimeout(() => {
        document.getElementById('edit-ticket-gain').focus();
    }, 100);
}

// Définir un gain rapide
function setQuickGain(value) {
    document.getElementById('edit-ticket-gain').value = value;
}

// Fermer la modal d'édition
function closeEditTicketModal() {
    const modal = document.getElementById('edit-ticket-modal');
    if (modal) modal.remove();
}

// Sauvegarder la modification d'un ticket
async function saveTicketEdit(ticketId) {
    const input = document.getElementById('edit-ticket-gain');
    const gainValue = input.value.trim();
    
    // Si vide, mettre null (ticket en attente)
    const gain = gainValue === '' ? null : parseFloat(gainValue);
    
    if (gain !== null && isNaN(gain)) {
        alert('Veuillez entrer un montant valide.');
        return;
    }
    
    if (gain !== null && gain < 0) {
        alert('Le gain ne peut pas être négatif.');
        return;
    }
    
    try {
        const tickets = await getTicketsByGame(currentGameId);
        const ticket = tickets.find(t => t.id === ticketId);
        
        if (ticket) {
            ticket.gain = gain;
            await updateTicket(ticket);
            closeEditTicketModal();
            await loadGameDetail();
            showToast('Ticket mis à jour !', 'success');
        }
    } catch (error) {
        console.error('Erreur lors de la mise à jour:', error);
        alert('Erreur lors de la mise à jour du ticket.');
    }
}

// Confirmer la suppression d'un ticket
function deleteTicketConfirm(ticketId) {
    if (confirm('Supprimer ce ticket ?')) {
        deleteTicketAndRefresh(ticketId);
    }
}

// Supprimer un ticket et rafraîchir
async function deleteTicketAndRefresh(ticketId) {
    try {
        await deleteTicket(ticketId);
        closeEditTicketModal();
        await loadGameDetail();
        showToast('Ticket supprimé', 'success');
    } catch (error) {
        console.error('Erreur lors de la suppression:', error);
        alert('Erreur lors de la suppression du ticket.');
    }
}

// Toast notification
function showToast(message, type = 'info') {
    const existingToast = document.querySelector('.toast');
    if (existingToast) existingToast.remove();
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

// Ajouter un nouveau ticket (pré-enregistrement)
function addTicketRow() {
    newTicketsToAdd.push({ gain: null }); // null = en attente par défaut
    renderNewTickets();
}

function removeNewTicket(index) {
    newTicketsToAdd.splice(index, 1);
    renderNewTickets();
}

function updateNewTicketGain(index, value) {
    const trimmed = value.trim();
    newTicketsToAdd[index].gain = trimmed === '' ? null : parseFloat(trimmed);
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

    container.innerHTML = newTicketsToAdd.map((ticket, index) => {
        const gainValue = (ticket.gain !== null && ticket.gain !== undefined) ? ticket.gain : '';
        return `
            <div class="new-ticket-row">
                <div class="ticket-number">+</div>
                <input type="number" 
                       step="0.5" 
                       min="0" 
                       placeholder="Gain (€) - vide si pas gratté"
                       value="${gainValue}"
                       onchange="updateNewTicketGain(${index}, this.value)"
                       oninput="updateNewTicketGain(${index}, this.value)">
                <button class="remove-ticket-btn" onclick="removeNewTicket(${index})">−</button>
            </div>
        `;
    }).join('');
}

async function saveNewTickets() {
    if (newTicketsToAdd.length === 0) return;

    const tickets = newTicketsToAdd.map(t => ({
        gameId: currentGameId,
        gain: t.gain, // Peut être null si en attente
        createdAt: new Date().toISOString()
    }));

    try {
        await addTickets(tickets);
        newTicketsToAdd = [];
        await loadGameDetail();
        showToast(`${tickets.length} ticket(s) ajouté(s)`, 'success');
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
