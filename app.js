// ==================== GraGa! V-1.7.0 ====================
// Nouveautés 1.7.0 : synchronisation avec le serveur maison (sync-maison.js).
//  - identifiants texte (crypto.randomUUID) au lieu des numéros auto-incrémentés,
//    avec migration automatique des données existantes (base v1 ou v2 → v3) ;
//  - champ updatedAt sur chaque jeu, ticket et groupe ;
//  - chaque écriture est signalée à SyncMaison (modifie / supprime).

// ==================== Configuration IndexedDB ====================
const DB_NAME = 'GrattageTrackerDB';
const DB_VERSION = 3; // v1 : 1.5 · v2 : 1.6 (groupes) · v3 : 1.7 (id texte + updatedAt)
const APP_VERSION = '1.7.0';
const SYNC_STORES = ['games', 'tickets', 'groups']; // tous les stores de données
let db;

// Identifiant unique de type texte
function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Stores au format v3 : clé texte, pas d'autoIncrement, index "name" non unique
// (deux appareils peuvent créer le même nom hors ligne ; le contrôle se fait dans l'interface)
function createDataStores(database) {
    const games = database.createObjectStore('games', { keyPath: 'id' });
    games.createIndex('name', 'name', { unique: false });

    const tickets = database.createObjectStore('tickets', { keyPath: 'id' });
    tickets.createIndex('gameId', 'gameId', { unique: false });

    const groups = database.createObjectStore('groups', { keyPath: 'id' });
    groups.createIndex('name', 'name', { unique: false });
}

let migratedGroupIds = null; // ancien numéro de groupe → nouvel id (pour les préférences d'affichage)

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            alert('Mise à jour de GRAGA en attente : fermez les autres onglets ou fenêtres de GRAGA, puis rechargez cette page.');
        };
        request.onsuccess = () => {
            db = request.result;
            db.onversionchange = () => {
                db.close();
                alert('GRAGA a été mise à jour dans un autre onglet. Rechargez cette page.');
            };
            if (migratedGroupIds) remapOpenGroups(migratedGroupIds);
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = request.result;
            if (event.oldVersion < 1) {
                createDataStores(database); // première installation
                return;
            }
            if (event.oldVersion < 3) {
                migrateToTextIds(database, request.transaction);
            }
        };
    });
}

/**
 * Migration unique v1/v2 → v3, dans la transaction de mise à jour de la base.
 * 1. Les anciens stores sont renommés "xxx_ancien" (rien n'est effacé à ce stade).
 * 2. Les nouveaux stores sont créés sans autoIncrement.
 * 3. Chaque enregistrement reçoit un id texte ; l'ancien numéro est gardé dans ancienId ;
 *    updatedAt est ajouté ; les références (tickets.gameId, games.groupId) sont converties.
 * 4. La copie est vérifiée (nombre d'enregistrements, références, anciens id).
 * 5. Seulement ensuite, les anciens stores sont supprimés.
 * La transaction est atomique : en cas de problème elle est annulée et la base
 * reste exactement dans son état précédent.
 */
function migrateToTextIds(database, tx) {
    const now = Date.now();
    const legacyNames = SYNC_STORES.filter(name => database.objectStoreNames.contains(name));

    legacyNames.forEach(name => { tx.objectStore(name).name = `${name}_ancien`; });
    createDataStores(database);
    if (legacyNames.length === 0) return;

    const fail = (reason) => {
        console.error('[GRAGA] Migration annulée, données inchangées :', reason);
        try { tx.abort(); } catch { /* déjà annulée */ }
    };

    const old = { games: [], tickets: [], groups: [] };
    let pending = legacyNames.length;
    legacyNames.forEach(name => {
        const req = tx.objectStore(`${name}_ancien`).getAll();
        req.onsuccess = () => {
            old[name] = req.result;
            if (--pending === 0) copy();
        };
    });

    function copy() {
        try {
            const groupMap = new Map();
            const gameMap = new Map();

            const groups = old.groups.map(g => {
                const id = newId();
                groupMap.set(g.id, id);
                return { ...g, id, ancienId: g.id, updatedAt: now };
            });

            const games = old.games.map(g => {
                const id = newId();
                gameMap.set(g.id, id);
                const groupId = groupMap.has(g.groupId) ? groupMap.get(g.groupId) : null;
                return { ...g, id, ancienId: g.id, groupId, updatedAt: now };
            });

            const tickets = old.tickets.map(t => {
                const rec = { ...t, id: newId(), ancienId: t.id, updatedAt: now };
                if (gameMap.has(t.gameId)) {
                    rec.gameId = gameMap.get(t.gameId);
                } else {
                    // Ticket orphelin (jeu disparu) : conservé, mais rattaché à aucun jeu
                    rec.gameId = null;
                    rec.ancienGameId = t.gameId ?? null;
                }
                return rec;
            });

            const stores = { games, tickets, groups };
            SYNC_STORES.forEach(name => {
                const store = tx.objectStore(name);
                stores[name].forEach(rec => store.put(rec));
            });

            verify(stores);
            migratedGroupIds = groupMap;
        } catch (err) {
            fail(err);
        }
    }

    function verify(expected) {
        const copied = {};
        let left = SYNC_STORES.length;
        SYNC_STORES.forEach(name => {
            const req = tx.objectStore(name).getAll();
            req.onsuccess = () => {
                copied[name] = req.result;
                if (--left === 0) check();
            };
        });

        function check() {
            for (const name of SYNC_STORES) {
                const oldIds = old[name].map(r => r.id).sort((a, b) => a - b);
                const newOldIds = copied[name].map(r => r.ancienId).sort((a, b) => a - b);
                if (copied[name].length !== old[name].length || copied[name].length !== expected[name].length) {
                    return fail(`${name} : ${old[name].length} avant, ${copied[name].length} après`);
                }
                if (JSON.stringify(oldIds) !== JSON.stringify(newOldIds)) {
                    return fail(`${name} : anciens numéros différents`);
                }
                if (copied[name].some(r => typeof r.id !== 'string' || !r.id || typeof r.updatedAt !== 'number')) {
                    return fail(`${name} : id ou updatedAt manquant`);
                }
            }
            const gameIds = new Set(copied.games.map(g => g.id));
            const groupIds = new Set(copied.groups.map(g => g.id));
            if (copied.tickets.some(t => t.gameId !== null && !gameIds.has(t.gameId))) {
                return fail('tickets : référence de jeu cassée');
            }
            if (copied.games.some(g => g.groupId !== null && !groupIds.has(g.groupId))) {
                return fail('jeux : référence de groupe cassée');
            }

            // Copie vérifiée : on peut supprimer l'ancien contenu
            legacyNames.forEach(name => database.deleteObjectStore(`${name}_ancien`));
            console.info(`[GRAGA] Migration v3 réussie : ${copied.games.length} jeux, ` +
                `${copied.tickets.length} tickets, ${copied.groups.length} groupes.`);
        }
    }
}

// Exécute une transaction et résout quand elle est terminée.
// `work` reçoit la transaction et peut renvoyer une requête dont le résultat sera retourné.
function runTx(storeNames, mode, work) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeNames, mode);
        let result;
        const request = work(transaction);
        if (request && 'onsuccess' in request) {
            request.onsuccess = () => { result = request.result; };
        }
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = (e) => reject(e.target.error || transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

// ==================== Synchro (serveur maison) ====================
// Ces deux fonctions ne bloquent jamais l'appli : sans serveur ou hors de la maison,
// le module garde simplement les modifications en attente.
const Sync = {
    modifie(store, record) {
        try {
            const p = window.SyncMaison && window.SyncMaison.modifie(store, record);
            if (p && p.catch) p.catch(err => console.warn('[GRAGA] synchro :', err));
        } catch (err) {
            console.warn('[GRAGA] synchro :', err);
        }
    },
    supprime(store, id) {
        try {
            const p = window.SyncMaison && window.SyncMaison.supprime(store, id);
            if (p && p.catch) p.catch(err => console.warn('[GRAGA] synchro :', err));
        } catch (err) {
            console.warn('[GRAGA] synchro :', err);
        }
    }
};

// Avant un import ou un « tout effacer » : récupère d'abord les dernières données des
// autres appareils (si on est à la maison), pour que la suppression les concerne aussi.
async function syncBeforeReplace() {
    if (!isSyncConfigured()) return;
    try {
        showToast('🔄 Synchronisation…', 'info', 4000);
        await window.SyncMaison.synchroniser();
    } catch { /* hors de la maison : on continue avec les données locales */ }
}

function isSyncConfigured() {
    try {
        const inst = window.SyncMaison && window.SyncMaison.instance;
        return !!(inst && inst.reglages.serveur());
    } catch {
        return false;
    }
}

// Phrase ajoutée aux confirmations de suppression quand la synchro est configurée
function syncWarning() {
    return isSyncConfigured()
        ? '\n\nLa suppression s\'appliquera aussi à tous les appareils synchronisés.'
        : '';
}

// ==================== Lecture ====================
const getAllGames = () => runTx(['games'], 'readonly', t => t.objectStore('games').getAll());
const getAllTickets = () => runTx(['tickets'], 'readonly', t => t.objectStore('tickets').getAll());
const getAllGroups = () => runTx(['groups'], 'readonly', t => t.objectStore('groups').getAll());

const getTicketsByGame = (gameId) =>
    runTx(['tickets'], 'readonly', t => t.objectStore('tickets').index('gameId').getAll(gameId));

async function loadAllData() {
    const [games, tickets, groups] = await Promise.all([getAllGames(), getAllTickets(), getAllGroups()]);
    return { games, tickets, groups };
}

// ==================== Écriture (toujours suivie de Sync.modifie / Sync.supprime) ====================
const stamp = (record) => ({ ...record, updatedAt: Date.now() });

async function putRecords(storeName, records) {
    const stamped = records.map(stamp);
    await runTx([storeName], 'readwrite', t => {
        const store = t.objectStore(storeName);
        stamped.forEach(rec => store.put(rec));
    });
    stamped.forEach(rec => Sync.modifie(storeName, rec));
    return stamped;
}

async function addGame(game) {
    const [rec] = await putRecords('games', [{ ...game, id: newId() }]);
    return rec.id;
}

const updateGames = (games) => putRecords('games', games);
const updateGame = (game) => putRecords('games', [game]);

const addTickets = (tickets) => putRecords('tickets', tickets.map(t => ({ ...t, id: newId() })));
const updateTicket = (ticket) => putRecords('tickets', [ticket]);

async function addGroup(group) {
    const [rec] = await putRecords('groups', [{ ...group, id: newId() }]);
    return rec.id;
}

const updateGroup = (group) => putRecords('groups', [group]);

async function deleteTicket(ticketId) {
    await runTx(['tickets'], 'readwrite', t => { t.objectStore('tickets').delete(ticketId); });
    Sync.supprime('tickets', ticketId);
}

// Supprime un jeu et tous ses tickets
async function deleteGame(gameId) {
    let ticketIds = [];
    await runTx(['games', 'tickets'], 'readwrite', t => {
        t.objectStore('games').delete(gameId);
        const ticketsStore = t.objectStore('tickets');
        const req = ticketsStore.index('gameId').getAllKeys(gameId);
        req.onsuccess = () => {
            ticketIds = req.result;
            ticketIds.forEach(id => ticketsStore.delete(id));
        };
    });
    Sync.supprime('games', gameId);
    ticketIds.forEach(id => Sync.supprime('tickets', id));
}

// Supprime un groupe : ses jeux et leurs tickets sont CONSERVÉS (ils redeviennent indépendants)
async function deleteGroup(groupId) {
    const now = Date.now();
    let changed = [];
    await runTx(['groups', 'games'], 'readwrite', t => {
        t.objectStore('groups').delete(groupId);
        const gamesStore = t.objectStore('games');
        const req = gamesStore.getAll();
        req.onsuccess = () => {
            changed = req.result
                .filter(g => g.groupId === groupId)
                .map(g => ({ ...g, groupId: null, updatedAt: now }));
            changed.forEach(g => gamesStore.put(g));
        };
    });
    Sync.supprime('groups', groupId);
    changed.forEach(g => Sync.modifie('games', g));
}

// Efface toutes les données (et sur les appareils synchronisés)
async function resetAllData() {
    const keys = {};
    await runTx(SYNC_STORES, 'readwrite', t => {
        SYNC_STORES.forEach(name => {
            const store = t.objectStore(name);
            const req = store.getAllKeys();
            req.onsuccess = () => {
                keys[name] = req.result;
                store.clear();
            };
        });
    });
    SYNC_STORES.forEach(name => (keys[name] || []).forEach(id => Sync.supprime(name, id)));
}

// Remplace tout le contenu (import). Les updatedAt du fichier sont conservés tels quels.
async function replaceAllData(incoming) {
    const oldKeys = {};
    await runTx(SYNC_STORES, 'readwrite', t => {
        SYNC_STORES.forEach(name => {
            const store = t.objectStore(name);
            const req = store.getAllKeys();
            req.onsuccess = () => {
                oldKeys[name] = req.result;
                store.clear();
                incoming[name].forEach(rec => store.put(rec));
            };
        });
    });
    SYNC_STORES.forEach(name => {
        const kept = new Set(incoming[name].map(rec => rec.id));
        incoming[name].forEach(rec => Sync.modifie(name, rec));
        (oldKeys[name] || []).filter(id => !kept.has(id)).forEach(id => Sync.supprime(name, id));
    });
}

// Changements reçus du serveur : écrits SANS rappeler SyncMaison, puis l'écran est rafraîchi
async function applySyncChanges(changements) {
    await runTx(SYNC_STORES, 'readwrite', t => {
        for (const change of changements) {
            if (!SYNC_STORES.includes(change.store)) continue;
            const store = t.objectStore(change.store);
            const id = String(change.id);
            if (change.data === null || change.data === undefined) {
                store.delete(id); // sans effet si l'enregistrement n'existe pas
            } else {
                store.put({ ...change.data, id });
            }
        }
    });
    await refreshCurrentView();
}

// ==================== Calcul des statistiques (source unique) ====================
const isPending = (ticket) => ticket.gain === null || ticket.gain === undefined;

/**
 * Statistiques d'un ensemble de jeux (un jeu seul, un groupe, ou tout).
 * - spent        : prix × TOUS les tickets achetés (grattés ou non)
 * - gains        : cumul des gains des tickets grattés
 * - scratchedCost: prix × tickets grattés (sert au ROI et au classement)
 */
function computeStats(games, allTickets) {
    const priceById = new Map(games.map(g => [g.id, g.ticketPrice]));
    const nameById = new Map(games.map(g => [g.id, g.name]));

    const s = {
        bought: 0, scratched: 0, pending: 0,
        spent: 0, scratchedCost: 0, gains: 0,
        wins: 0, best: 0, bestGameName: null
    };

    for (const ticket of allTickets) {
        if (!priceById.has(ticket.gameId)) continue;
        const price = priceById.get(ticket.gameId);
        s.bought++;
        s.spent += price;

        if (isPending(ticket)) {
            s.pending++;
            continue;
        }

        s.scratched++;
        s.scratchedCost += price;
        s.gains += ticket.gain;
        if (ticket.gain > 0) s.wins++;
        if (ticket.gain > s.best) {
            s.best = ticket.gain;
            s.bestGameName = nameById.get(ticket.gameId);
        }
    }

    s.avgGain = s.scratched > 0 ? s.gains / s.scratched : 0;
    s.winRate = s.scratched > 0 ? (s.wins / s.scratched) * 100 : 0;
    s.returnRate = s.scratchedCost > 0 ? (s.gains / s.scratchedCost) * 100 : 0; // % des mises récupéré
    s.isProfitable = s.scratched > 0 && s.gains >= s.scratchedCost;
    return s;
}

function buildGameStats(games, tickets) {
    return games.map(game => {
        const s = computeStats([game], tickets);
        return {
            ...game,
            ticketCount: s.scratched,      // tickets grattés (classement)
            totalGains: s.gains,
            totalCost: s.scratchedCost,    // mises des tickets grattés (classement)
            winCount: s.wins,
            avgGain: s.avgGain,
            spent: s.spent,                // tous les tickets achetés (affichage)
            bought: s.bought
        };
    });
}

// ==================== Variables Globales ====================
let currentGameId = null;
let currentGroupId = null;
let returnToGroupId = null; // si on ouvre un jeu depuis la page d'un groupe
let newTicketsToAdd = [];

const OPEN_GROUPS_KEY = 'graga-open-groups';
const LAST_EXPORT_KEY = 'graga-last-export';

function loadOpenGroups() {
    try {
        return new Set(JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) || '[]').map(String));
    } catch {
        return new Set();
    }
}
let openGroups = loadOpenGroups();

function saveOpenGroups() {
    try {
        localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...openGroups]));
    } catch { /* stockage indisponible : on ignore */ }
}

// Après migration : les groupes dépliés étaient mémorisés avec leurs anciens numéros
function remapOpenGroups(groupMap) {
    const remapped = new Set();
    for (const [oldId, id] of groupMap) {
        if (openGroups.has(String(oldId))) remapped.add(id);
    }
    openGroups = remapped;
    saveOpenGroups();
}

// ==================== Navigation ====================
function showPage(pageId) {
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    document.getElementById(pageId).classList.add('active');
    window.scrollTo(0, 0);
}

function currentPageId() {
    const active = document.querySelector('.page.active');
    return active ? active.id : 'home-page';
}

function goHome() {
    showPage('home-page');
    newTicketsToAdd = [];
    returnToGroupId = null;
    loadHomePage();
}

async function showAddGame() {
    showPage('add-game-page');
    document.getElementById('add-game-form').reset();
    const groups = await getAllGroups();
    document.getElementById('game-group').innerHTML = groupOptionsHtml(groups, null);
}

function showAddGroup() {
    showPage('add-group-page');
    document.getElementById('add-group-form').reset();
}

function showSettings() {
    showPage('settings-page');
    loadSettingsStats();
}

async function showGameDetail(gameId, fromGroupId = null) {
    currentGameId = gameId;
    returnToGroupId = fromGroupId;
    newTicketsToAdd = [];
    showPage('game-detail-page');
    renderNewTickets();
    await loadGameDetail();
}

function backFromGameDetail() {
    newTicketsToAdd = [];
    if (returnToGroupId) {
        showGroupDetail(returnToGroupId);
    } else {
        goHome();
    }
}

async function showGroupDetail(groupId) {
    currentGroupId = groupId;
    showPage('group-page');
    await loadGroupDetail();
}

// Rafraîchit l'écran affiché (après réception de changements par la synchro)
async function refreshCurrentView() {
    try {
        switch (currentPageId()) {
            case 'home-page':
                await loadHomePage();
                break;
            case 'game-detail-page': {
                const games = await getAllGames();
                if (!games.some(g => g.id === currentGameId)) {
                    closeAllSheetModals();
                    showToast('Ce jeu a été supprimé sur un autre appareil', 'info', 3500);
                    goHome();
                    return;
                }
                await loadGameDetail();
                const modal = document.getElementById('edit-ticket-modal');
                if (modal) {
                    const tickets = await getTicketsByGame(currentGameId);
                    if (!tickets.some(t => t.id === modal.dataset.ticketId)) closeEditTicketModal();
                }
                break;
            }
            case 'group-page':
                await loadGroupDetail(); // revient à l'accueil si le groupe a disparu
                break;
            case 'settings-page':
                await loadSettingsStats();
                break;
            case 'ranking-page': {
                const { games, tickets } = await loadAllData();
                window.currentRankings = calculateRankings(buildGameStats(games, tickets).filter(g => g.ticketCount > 0));
                loadRankingPage();
                break;
            }
            default:
                break; // formulaires d'ajout : rien à rafraîchir
        }
    } catch (error) {
        console.error('[GRAGA] rafraîchissement :', error);
    }
}

// ==================== Page d'Accueil ====================
async function loadHomePage() {
    const { games, tickets, groups } = await loadAllData();

    games.sort((a, b) => a.name.localeCompare(b.name));
    groups.sort((a, b) => a.name.localeCompare(b.name));

    // Stats globales
    const global = computeStats(games, tickets);
    document.getElementById('total-gains').textContent = formatCurrency(global.gains);
    document.getElementById('total-spent').textContent = formatCurrency(global.spent);

    // Stats par jeu (pour la liste et le classement)
    const gameStats = buildGameStats(games, tickets);

    // Classement par médailles (jeux individuels uniquement)
    const gamesWithTickets = gameStats.filter(g => g.ticketCount > 0);
    window.currentRankings = calculateRankings(gamesWithTickets);

    const { globalRanking } = window.currentRankings;
    if (globalRanking.length > 0) {
        const bestGame = globalRanking[0];
        const worstGame = globalRanking[globalRanking.length - 1];
        document.getElementById('best-game').innerHTML = medalSummaryHtml(bestGame);
        document.getElementById('worst-game').innerHTML =
            globalRanking.length > 1 ? medalSummaryHtml(worstGame) : '<small>Il faut au moins 2 jeux</small>';
    } else {
        document.getElementById('best-game').textContent = '-';
        document.getElementById('worst-game').textContent = '-';
    }

    // Liste : groupes d'abord, puis jeux indépendants
    const gamesList = document.getElementById('games-list');

    if (games.length === 0 && groups.length === 0) {
        gamesList.innerHTML = '<p class="empty-state">Aucun jeu enregistré.<br>Cliquez sur ➕ pour ajouter un jeu.</p>';
        return;
    }

    const groupIds = new Set(groups.map(g => g.id));

    const groupsHtml = groups.map(group => {
        const members = gameStats.filter(g => g.groupId === group.id);
        const s = computeStats(members, tickets);
        const isOpen = openGroups.has(group.id);

        // Petit duel "fun" : meilleur et moins bon retour sur mises dans le groupe
        const played = members
            .map(g => ({ g, s: computeStats([g], tickets) }))
            .filter(x => x.s.scratched > 0)
            .sort((a, b) => b.s.returnRate - a.s.returnRate);

        let duelHtml = '';
        if (played.length >= 2) {
            const top = played[0];
            const bottom = played[played.length - 1];
            duelHtml = `
                <div class="group-duel">
                    <span>🏆 ${escapeHtml(top.g.name)} <strong class="${top.s.isProfitable ? 'positive' : 'negative'}">${formatPercent(top.s.returnRate)}</strong></span>
                    <span>📉 ${escapeHtml(bottom.g.name)} <strong class="${bottom.s.isProfitable ? 'positive' : 'negative'}">${formatPercent(bottom.s.returnRate)}</strong></span>
                </div>`;
        }

        const membersHtml = members.length > 0
            ? members.map(g => gameCardHtml(g)).join('')
            : '<p class="group-empty">Aucun jeu dans ce groupe.<br>Ouvrez le détail pour en insérer.</p>';

        return `
            <div class="group-card ${isOpen ? 'open' : ''}" data-group-id="${escapeHtml(group.id)}">
                <div class="group-header" onclick="toggleGroup(${jsArg(group.id)})">
                    <span class="group-chevron">▸</span>
                    <div class="group-info">
                        <div class="group-name">📁 ${escapeHtml(group.name)}</div>
                        <div class="group-meta">${members.length} jeu${members.length > 1 ? 'x' : ''} · ${s.bought} ticket${s.bought > 1 ? 's' : ''}</div>
                    </div>
                    <div class="game-stat">
                        <span class="game-stat-label">Gain moyen</span>
                        <span class="game-stat-value ${s.scratched === 0 ? '' : (s.isProfitable ? 'positive' : 'negative')}">
                            ${formatCurrency(s.avgGain)}
                        </span>
                    </div>
                    <div class="game-stat">
                        <span class="game-stat-label">Dépensé</span>
                        <span class="game-stat-value">${formatCurrency(s.spent)}</span>
                    </div>
                </div>
                <div class="group-body">
                    ${duelHtml}
                    <div class="group-games">${membersHtml}</div>
                    <button class="group-detail-btn" onclick="showGroupDetail(${jsArg(group.id)})">📊 Détail du groupe</button>
                </div>
            </div>
        `;
    }).join('');

    const ungrouped = gameStats.filter(g => !g.groupId || !groupIds.has(g.groupId));
    const ungroupedHtml = ungrouped.map(g => gameCardHtml(g)).join('');

    gamesList.innerHTML = groupsHtml + ungroupedHtml;
}

function medalSummaryHtml(game) {
    return `
        <span class="clickable-stat">${escapeHtml(game.name)}</span>
        <small>🥇${game.gold} 🥈${game.silver} 🥉${game.bronze}</small>
    `;
}

function gameCardHtml(game, fromGroupId = null) {
    const hasData = game.ticketCount > 0;
    const args = fromGroupId ? `${jsArg(game.id)}, ${jsArg(fromGroupId)}` : jsArg(game.id);
    return `
        <div class="game-card" onclick="showGameDetail(${args})">
            <div class="game-name">${escapeHtml(game.name)}</div>
            <div class="game-stat">
                <span class="game-stat-label">Gain moyen</span>
                <span class="game-stat-value ${!hasData ? '' : (game.avgGain >= game.ticketPrice ? 'positive' : 'negative')}">
                    ${formatCurrency(game.avgGain)}
                </span>
            </div>
            <div class="game-stat">
                <span class="game-stat-label">Dépensé</span>
                <span class="game-stat-value">${formatCurrency(game.spent)}</span>
            </div>
        </div>
    `;
}

function toggleGroup(groupId) {
    const card = [...document.querySelectorAll('.group-card')].find(el => el.dataset.groupId === groupId);
    if (!card) return;
    const isOpen = card.classList.toggle('open');
    if (isOpen) openGroups.add(groupId); else openGroups.delete(groupId);
    saveOpenGroups();
}

// Comparaison de noms sans tenir compte des majuscules ni des espaces autour
const sameName = (a, b) =>
    String(a || '').trim().toLocaleLowerCase('fr') === String(b || '').trim().toLocaleLowerCase('fr');

// ==================== Ajout de Jeu ====================
document.getElementById('add-game-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('game-name').value.trim();
    const ticketPrice = parseFloat(document.getElementById('ticket-price').value);
    const groupId = document.getElementById('game-group').value || null;

    if (!name || isNaN(ticketPrice) || ticketPrice <= 0) {
        alert('Veuillez remplir tous les champs correctement.');
        return;
    }

    try {
        const games = await getAllGames();
        if (games.some(g => sameName(g.name, name))) {
            alert('Un jeu avec ce nom existe déjà.');
            return;
        }
        await addGame({
            name,
            ticketPrice,
            groupId,
            createdAt: new Date().toISOString()
        });
        showToast('Jeu ajouté !', 'success');
        goHome();
    } catch (error) {
        alert('Erreur lors de l\'ajout du jeu.');
        console.error(error);
    }
});

// ==================== Ajout de Groupe ====================
document.getElementById('add-group-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('group-name').value.trim();
    if (!name) {
        alert('Veuillez donner un nom au groupe.');
        return;
    }

    try {
        const groups = await getAllGroups();
        if (groups.some(g => sameName(g.name, name))) {
            alert('Un groupe avec ce nom existe déjà.');
            return;
        }
        const groupId = await addGroup({ name, createdAt: new Date().toISOString() });
        openGroups.add(groupId);
        saveOpenGroups();
        await showGroupDetail(groupId);
        // Enchaîne directement sur l'insertion des jeux
        openGroupGamesModal();
    } catch (error) {
        alert('Erreur lors de la création du groupe.');
        console.error(error);
    }
});

function groupOptionsHtml(groups, selectedId) {
    const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name));
    return `<option value="">Aucun groupe</option>` + sorted.map(g =>
        `<option value="${escapeHtml(g.id)}" ${g.id === selectedId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`
    ).join('');
}

// ==================== Page Groupe ====================
async function loadGroupDetail() {
    const { games, tickets, groups } = await loadAllData();
    const group = groups.find(g => g.id === currentGroupId);

    if (!group) {
        closeAllSheetModals();
        goHome();
        return;
    }

    document.getElementById('group-title').textContent = '📁 ' + group.name;

    const members = games
        .filter(g => g.groupId === group.id)
        .sort((a, b) => a.name.localeCompare(b.name));
    const s = computeStats(members, tickets);

    document.getElementById('group-games-count').textContent = members.length;
    document.getElementById('group-tickets-count').textContent = s.bought;
    const pendingEl = document.getElementById('group-pending-count');
    if (s.pending > 0) {
        pendingEl.textContent = `${s.pending} en attente`;
        pendingEl.classList.remove('hidden');
    } else {
        pendingEl.classList.add('hidden');
    }
    document.getElementById('group-total-cost').textContent = formatCurrency(s.spent);
    document.getElementById('group-total-gains').textContent = formatCurrency(s.gains);
    document.getElementById('group-avg-gain').textContent = formatCurrency(s.avgGain);
    document.getElementById('group-win-rate').textContent = s.winRate.toFixed(1) + '%';
    document.getElementById('group-best-gain').textContent = formatCurrency(s.best);
    document.getElementById('group-best-game').textContent = s.bestGameName ? s.bestGameName : '';

    // Comparaison des jeux du groupe, triés par retour sur mises
    const container = document.getElementById('group-games-container');

    if (members.length === 0) {
        container.innerHTML = '<p class="empty-state">Aucun jeu dans ce groupe.<br>Cliquez sur ➕ pour en insérer.</p>';
        return;
    }

    const rows = members.map(game => {
        const gs = computeStats([game], tickets);
        return { game, gs };
    }).sort((a, b) => {
        // Les jeux joués d'abord, puis par retour décroissant
        if ((a.gs.scratched > 0) !== (b.gs.scratched > 0)) return a.gs.scratched > 0 ? -1 : 1;
        return b.gs.returnRate - a.gs.returnRate;
    });

    const maxReturn = Math.max(100, ...rows.map(r => r.gs.returnRate));
    let podium = 0;

    container.innerHTML = rows.map(({ game, gs }) => {
        const played = gs.scratched > 0;
        const medal = played && podium < 3 ? ['🥇', '🥈', '🥉'][podium++] : '';
        const width = played ? Math.max(2, (gs.returnRate / maxReturn) * 100) : 0;
        const breakEven = (100 / maxReturn) * 100;

        return `
            <div class="compare-card" onclick="showGameDetail(${jsArg(game.id)}, ${jsArg(group.id)})">
                <div class="compare-top">
                    <span class="compare-name">${medal ? medal + ' ' : ''}${escapeHtml(game.name)}</span>
                    <span class="compare-return ${played ? (gs.isProfitable ? 'positive' : 'negative') : ''}">
                        ${played ? formatPercent(gs.returnRate) : 'Pas de données'}
                    </span>
                </div>
                <div class="compare-bar-track">
                    <div class="compare-bar ${gs.isProfitable ? 'positive' : ''}" style="width:${width}%"></div>
                    <div class="compare-breakeven" style="left:${breakEven}%"></div>
                </div>
                <div class="compare-stats">
                    <span>${gs.bought} ticket${gs.bought > 1 ? 's' : ''}</span>
                    <span>Moy. ${formatCurrency(gs.avgGain)}</span>
                    <span>Dépensé ${formatCurrency(gs.spent)}</span>
                    <span>${gs.winRate.toFixed(0)}% gagnants</span>
                </div>
            </div>
        `;
    }).join('');
}

// Modal d'insertion / retrait des jeux d'un groupe
async function openGroupGamesModal() {
    const { games, groups } = await loadAllData();
    const groupNames = new Map(groups.map(g => [g.id, g.name]));
    games.sort((a, b) => a.name.localeCompare(b.name));

    const listHtml = games.length === 0
        ? '<p class="empty-state">Aucun jeu enregistré.<br>Créez d\'abord vos jeux.</p>'
        : games.map(game => {
            const inThis = game.groupId === currentGroupId;
            const otherGroup = !inThis && game.groupId && groupNames.has(game.groupId)
                ? groupNames.get(game.groupId) : null;
            return `
                <label class="check-row">
                    <input type="checkbox" value="${escapeHtml(game.id)}" ${inThis ? 'checked' : ''}>
                    <span class="check-name">${escapeHtml(game.name)}</span>
                    ${otherGroup ? `<span class="check-note">dans « ${escapeHtml(otherGroup)} »</span>` : ''}
                </label>
            `;
        }).join('');

    openSheetModal('group-games-modal', `
        <h2>Jeux du groupe</h2>
        <p class="sheet-hint">Cochez les jeux à mettre dans ce groupe. Un jeu déjà dans un autre groupe y sera déplacé.</p>
        <div class="check-list">${listHtml}</div>
        <div class="modal-actions">
            <button class="btn btn-outline" onclick="closeSheetModal('group-games-modal')">Annuler</button>
            <button class="btn btn-primary" onclick="saveGroupGames()">Valider</button>
        </div>
    `);
}

async function saveGroupGames() {
    const checked = new Set(
        [...document.querySelectorAll('#group-games-modal .check-row input:checked')].map(input => input.value)
    );

    try {
        const games = await getAllGames();
        const changed = [];
        for (const game of games) {
            const shouldBeIn = checked.has(game.id);
            const isIn = game.groupId === currentGroupId;
            if (shouldBeIn && !isIn) changed.push({ ...game, groupId: currentGroupId });
            if (!shouldBeIn && isIn) changed.push({ ...game, groupId: null });
        }
        if (changed.length > 0) await updateGames(changed);
        closeSheetModal('group-games-modal');
        await loadGroupDetail();
        showToast('Groupe mis à jour !', 'success');
    } catch (error) {
        console.error(error);
        alert('Erreur lors de la mise à jour du groupe.');
    }
}

async function openRenameGroupModal() {
    const groups = await getAllGroups();
    const group = groups.find(g => g.id === currentGroupId);
    if (!group) return;

    openSheetModal('rename-group-modal', `
        <h2>Renommer le groupe</h2>
        <div class="edit-form">
            <label for="rename-group-input">Nom du groupe</label>
            <input type="text" id="rename-group-input" value="${escapeHtml(group.name)}">
        </div>
        <div class="modal-actions">
            <button class="btn btn-outline" onclick="closeSheetModal('rename-group-modal')">Annuler</button>
            <button class="btn btn-primary" onclick="saveGroupRename()">Enregistrer</button>
        </div>
    `);
    setTimeout(() => document.getElementById('rename-group-input')?.focus(), 100);
}

async function saveGroupRename() {
    const name = document.getElementById('rename-group-input').value.trim();
    if (!name) {
        alert('Le nom ne peut pas être vide.');
        return;
    }
    try {
        const groups = await getAllGroups();
        const group = groups.find(g => g.id === currentGroupId);
        if (!group) return;
        if (groups.some(g => g.id !== group.id && sameName(g.name, name))) {
            alert('Un groupe avec ce nom existe déjà.');
            return;
        }
        await updateGroup({ ...group, name });
        closeSheetModal('rename-group-modal');
        await loadGroupDetail();
        showToast('Groupe renommé', 'success');
    } catch (error) {
        console.error(error);
        alert('Erreur lors du renommage.');
    }
}

function confirmDeleteGroup() {
    showModal(
        'Supprimer le groupe',
        'Le groupe sera supprimé, mais ses jeux et leurs tickets sont conservés.' + syncWarning(),
        async () => {
            try {
                await deleteGroup(currentGroupId);
                openGroups.delete(currentGroupId);
                saveOpenGroups();
                closeModal();
                showToast('Groupe supprimé', 'success');
                goHome();
            } catch (error) {
                console.error(error);
                closeModal();
                alert('Erreur lors de la suppression du groupe.');
            }
        }
    );
}

// ==================== Détail du Jeu ====================
async function loadGameDetail() {
    const { games, tickets: allTickets, groups } = await loadAllData();
    const game = games.find(g => g.id === currentGameId);

    if (!game) {
        goHome();
        return;
    }

    document.getElementById('detail-game-name').textContent = game.name;
    document.getElementById('detail-game-group').innerHTML = groupOptionsHtml(groups, game.groupId || null);

    const tickets = allTickets.filter(t => t.gameId === game.id);
    const s = computeStats([game], tickets);

    document.getElementById('detail-tickets-count').textContent = s.bought;
    document.getElementById('detail-total-cost').textContent = formatCurrency(s.spent);
    document.getElementById('detail-total-gains').textContent = formatCurrency(s.gains);
    document.getElementById('detail-avg-gain').textContent = formatCurrency(s.avgGain);
    document.getElementById('detail-win-rate').textContent = s.winRate.toFixed(1) + '%';
    document.getElementById('detail-best-gain').textContent = formatCurrency(s.best);

    const pendingCountEl = document.getElementById('detail-pending-count');
    if (s.pending > 0) {
        pendingCountEl.textContent = `${s.pending} en attente`;
        pendingCountEl.classList.remove('hidden');
    } else {
        pendingCountEl.classList.add('hidden');
    }

    const ticketsContainer = document.getElementById('tickets-container');

    if (tickets.length === 0) {
        ticketsContainer.innerHTML = '<p class="empty-state">Aucun ticket.<br>Cliquez sur ➕ pour ajouter un ticket.</p>';
        return;
    }

    // Numéro fixe = ordre d'achat (le 1er acheté est le #1).
    // Départage : ancien numéro (tickets migrés), puis id.
    const chronological = [...tickets].sort((a, b) =>
        ((new Date(a.createdAt) - new Date(b.createdAt)) || 0) ||
        ((a.ancienId ?? 0) - (b.ancienId ?? 0)) ||
        String(a.id).localeCompare(String(b.id)));
    const numberById = new Map(chronological.map((t, i) => [t.id, i + 1]));

    // Affichage : à gratter d'abord, puis du plus récent au plus ancien (tri stable)
    const displayed = [...chronological].reverse().sort((a, b) => {
        if (isPending(a) !== isPending(b)) return isPending(a) ? -1 : 1;
        return 0;
    });

    ticketsContainer.innerHTML = displayed.map(ticket => {
        const pending = isPending(ticket);
        const gainClass = pending ? 'pending' : (ticket.gain > 0 ? 'positive' : 'zero');
        const gainText = pending ? 'À gratter' : formatCurrency(ticket.gain);
        const num = numberById.get(ticket.id);

        return `
            <div class="ticket-row clickable" onclick="openEditTicketModal(${jsArg(ticket.id)})">
                <div class="ticket-number">${num}</div>
                <div class="ticket-label">Ticket #${num}</div>
                <div class="ticket-gain ${gainClass}">${gainText}</div>
                <div class="ticket-edit-icon">✏️</div>
            </div>
        `;
    }).join('');
}

// Changement de groupe depuis la page du jeu
async function changeGameGroup(value) {
    const groupId = value || null;
    try {
        const games = await getAllGames();
        const game = games.find(g => g.id === currentGameId);
        if (!game) return;
        await updateGame({ ...game, groupId });
        showToast(groupId ? 'Jeu placé dans le groupe' : 'Jeu retiré du groupe', 'success');
        // Si on venait d'un groupe que le jeu vient de quitter, le retour ira à l'accueil
        if (returnToGroupId && returnToGroupId !== groupId) returnToGroupId = null;
    } catch (error) {
        console.error(error);
        alert('Erreur lors du changement de groupe.');
    }
}

// ==================== Modals "feuille" (édition, groupes) ====================
function openSheetModal(id, innerHtml) {
    closeSheetModal(id);
    document.body.insertAdjacentHTML('beforeend', `
        <div id="${id}" class="sheet-modal">
            <div class="modal-overlay" onclick="closeSheetModal('${id}')"></div>
            <div class="modal-content">${innerHtml}</div>
        </div>
    `);
    return document.getElementById(id);
}

function closeSheetModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.remove();
}

function closeAllSheetModals() {
    document.querySelectorAll('.sheet-modal').forEach(m => m.remove());
}

function closeTopSheetModal() {
    const modals = document.querySelectorAll('.sheet-modal');
    if (modals.length === 0) return false;
    modals[modals.length - 1].remove();
    return true;
}

// Ouvrir la modal d'édition d'un ticket existant
async function openEditTicketModal(ticketId) {
    const tickets = await getTicketsByGame(currentGameId);
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) return;

    const currentGain = isPending(ticket) ? '' : ticket.gain;
    const quick = [0, 2, 5, 10, 20, 50, 100];

    const modal = openSheetModal('edit-ticket-modal', `
        <h2>Modifier le ticket</h2>
        <div class="edit-form">
            <label for="edit-ticket-gain">Gain obtenu (€)</label>
            <input type="number" id="edit-ticket-gain" step="0.5" min="0" inputmode="decimal"
                   placeholder="Laisser vide si pas encore gratté" value="${currentGain}">
            <div class="quick-gains">
                <span class="quick-label">Gains rapides :</span>
                <div class="quick-buttons">
                    ${quick.map(v => `<button type="button" class="quick-btn" onclick="setQuickGain(${v})">${v}€</button>`).join('')}
                </div>
            </div>
        </div>
        <div class="modal-actions">
            <button class="btn btn-outline" onclick="closeEditTicketModal()">Annuler</button>
            <button class="btn btn-danger-outline" onclick="deleteTicketConfirm(${jsArg(ticketId)})">Supprimer</button>
            <button class="btn btn-primary" onclick="saveTicketEdit(${jsArg(ticketId)})">Enregistrer</button>
        </div>
    `);
    modal.dataset.ticketId = ticketId;

    setTimeout(() => document.getElementById('edit-ticket-gain')?.focus(), 100);
}

function setQuickGain(value) {
    document.getElementById('edit-ticket-gain').value = value;
}

function closeEditTicketModal() {
    closeSheetModal('edit-ticket-modal');
}

// Renvoie null (en attente), un nombre valide, ou undefined si la saisie est invalide
function parseGainInput(raw) {
    const value = String(raw ?? '').trim().replace(',', '.');
    if (value === '') return null;
    const gain = parseFloat(value);
    if (!Number.isFinite(gain) || gain < 0) return undefined;
    return gain;
}

async function saveTicketEdit(ticketId) {
    const gain = parseGainInput(document.getElementById('edit-ticket-gain').value);

    if (gain === undefined) {
        alert('Veuillez entrer un montant valide (positif ou nul).');
        return;
    }

    try {
        const tickets = await getTicketsByGame(currentGameId);
        const ticket = tickets.find(t => t.id === ticketId);
        if (ticket) {
            await updateTicket({ ...ticket, gain });
            closeEditTicketModal();
            await loadGameDetail();
            showToast('Ticket mis à jour !', 'success');
        }
    } catch (error) {
        console.error('Erreur lors de la mise à jour:', error);
        alert('Erreur lors de la mise à jour du ticket.');
    }
}

function deleteTicketConfirm(ticketId) {
    if (confirm('Supprimer ce ticket ?' + syncWarning())) {
        deleteTicketAndRefresh(ticketId);
    }
}

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

// ==================== Nouveaux tickets ====================
function addTicketRow() {
    newTicketsToAdd.push({ raw: '' }); // vide = en attente
    renderNewTickets();
    const inputs = document.querySelectorAll('#new-tickets-container input');
    inputs[inputs.length - 1]?.focus();
}

function removeNewTicket(index) {
    newTicketsToAdd.splice(index, 1);
    renderNewTickets();
}

function updateNewTicketGain(index, value) {
    if (newTicketsToAdd[index]) newTicketsToAdd[index].raw = value;
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
            <input type="number" step="0.5" min="0" inputmode="decimal"
                   placeholder="Gain (€) - vide si pas gratté"
                   value="${escapeHtml(ticket.raw)}"
                   oninput="updateNewTicketGain(${index}, this.value)">
            <button class="remove-ticket-btn" onclick="removeNewTicket(${index})">−</button>
        </div>
    `).join('');
}

async function saveNewTickets() {
    if (newTicketsToAdd.length === 0) return;

    const gains = newTicketsToAdd.map(t => parseGainInput(t.raw));
    if (gains.some(g => g === undefined)) {
        alert('Un des montants est invalide (il doit être positif ou nul).');
        return;
    }

    const now = Date.now();
    const tickets = gains.map((gain, i) => ({
        gameId: currentGameId,
        gain, // null si en attente
        createdAt: new Date(now + i).toISOString() // +1 ms par ticket : ordre garanti
    }));

    try {
        await addTickets(tickets);
        newTicketsToAdd = [];
        renderNewTickets();
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
        'Êtes-vous sûr de vouloir supprimer ce jeu et tous ses tickets ?' + syncWarning(),
        async () => {
            try {
                await deleteGame(currentGameId);
                closeModal();
                showToast('Jeu supprimé', 'success');
                backFromGameDetail();
            } catch (error) {
                console.error(error);
                closeModal();
                alert('Erreur lors de la suppression du jeu.');
            }
        }
    );
}

function confirmResetAll() {
    showModal(
        'Réinitialiser',
        'Êtes-vous sûr de vouloir supprimer TOUTES les données (jeux, tickets et groupes) ? Cette action est irréversible.' +
        (isSyncConfigured() ? '\n\nElles seront supprimées sur tous les appareils synchronisés.' : ''),
        async () => {
            try {
                closeModal();
                await syncBeforeReplace();
                await resetAllData();
                openGroups = new Set();
                saveOpenGroups();
                closeModal();
                showToast('Données réinitialisées', 'success');
                goHome();
            } catch (error) {
                console.error(error);
                closeModal();
                alert('Erreur lors de la réinitialisation.');
            }
        }
    );
}

// ==================== Paramètres ====================
async function loadSettingsStats() {
    const { games, tickets, groups } = await loadAllData();

    document.getElementById('stats-total-games').textContent = games.length;
    document.getElementById('stats-total-groups').textContent = groups.length;
    document.getElementById('stats-total-tickets').textContent = tickets.length;
    document.getElementById('stats-winning-tickets').textContent = tickets.filter(t => t.gain > 0).length;

    let lastExport = null;
    try { lastExport = localStorage.getItem(LAST_EXPORT_KEY); } catch { /* ignore */ }
    const lastExportEl = document.getElementById('last-export');
    if (lastExport) {
        const days = Math.floor((Date.now() - new Date(lastExport)) / 86400000);
        const when = days === 0 ? "aujourd'hui" : days === 1 ? 'hier' : `il y a ${days} jours`;
        lastExportEl.textContent = `Dernière sauvegarde : ${when}`;
        lastExportEl.classList.toggle('stale', days >= 30);
    } else {
        lastExportEl.textContent = 'Aucune sauvegarde effectuée pour le moment';
        lastExportEl.classList.add('stale');
    }
}

function openHomeServer() {
    if (window.SyncMaison && window.SyncMaison.instance) {
        window.SyncMaison.ouvrirReglages();
    } else {
        alert('Le module de synchronisation n\'a pas pu être chargé (fichier sync-maison.js manquant ?).');
    }
}

// Petite ligne d'état sous le bouton « Serveur maison »
function updateSyncStatus(e) {
    const el = document.getElementById('sync-status');
    if (!el || !e) return;
    const labels = {
        'ok': '✅ Synchronisé',
        'en-cours': '🔄 Synchronisation…',
        'hors-maison': '🏠 Hors de la maison',
        'non-connecte': '🔑 Compte non connecté',
        'non-configure': 'Serveur non configuré',
        'erreur': '⚠️ Erreur de synchro',
        'inactif': 'Serveur maison'
    };
    let text = labels[e.statut] || e.statut;
    if (e.derniere) {
        text += ` · dernière synchro ${new Date(e.derniere).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`;
    }
    if (e.enAttente) text += ` · ${e.enAttente} modification${e.enAttente > 1 ? 's' : ''} en attente`;
    el.textContent = text;
}

// ==================== EXPORT / IMPORT ====================
async function exportData() {
    try {
        const { games, tickets, groups } = await loadAllData();

        const payload = {
            version: 3,
            appVersion: APP_VERSION,
            exportDate: new Date().toISOString(),
            appName: 'GRAGA',
            data: { games, tickets, groups }
        };

        const jsonString = JSON.stringify(payload, null, 2);
        const dateStr = new Date().toISOString().split('T')[0];
        const fileName = `graga-backup-${dateStr}.json`;
        const plugins = window.Capacitor && window.Capacitor.Plugins;

        if (plugins && plugins.Filesystem && plugins.Share) {
            // Android : écrit un vrai fichier .json puis ouvre le menu de partage
            const result = await plugins.Filesystem.writeFile({
                path: fileName,
                data: jsonString,
                directory: 'CACHE',
                encoding: 'utf8'
            });
            await plugins.Share.share({
                title: 'Sauvegarde GraGa!',
                url: result.uri,
                dialogTitle: 'Sauvegarder vers...'
            });
        } else if (plugins && plugins.Share) {
            // Repli : partage du JSON en texte
            await plugins.Share.share({
                title: 'Sauvegarde GraGa!',
                text: jsonString,
                dialogTitle: 'Sauvegarder vers...'
            });
        } else {
            // Navigateur : téléchargement direct
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        try { localStorage.setItem(LAST_EXPORT_KEY, new Date().toISOString()); } catch { /* ignore */ }
        showToast('✅ Export prêt !', 'success');
        loadSettingsStats();
    } catch (error) {
        // L'utilisateur qui ferme le menu de partage n'est pas une vraie erreur
        if (error && /cancel/i.test(error.message || '')) return;
        console.error('Erreur export:', error);
        showToast('❌ Erreur lors de l\'export', 'error');
    }
}

/**
 * Vérifie et convertit le contenu d'un fichier de sauvegarde.
 * - ancien format (1.5 / 1.6) : id numériques → nouveaux id texte, ancien numéro dans ancienId,
 *   références tickets.gameId et games.groupId converties ;
 * - nouveau format (1.7) : id texte conservés tels quels.
 * updatedAt : celui du fichier est gardé ; s'il n'y en a pas, 1 (le fichier est alors
 * considéré comme ancien et ne remplacera pas une version plus récente du serveur).
 */
function validateImport(imported) {
    const data = imported && imported.data;
    if (!data || !Array.isArray(data.games) || !Array.isArray(data.tickets)) {
        throw new Error('Format de fichier invalide');
    }

    const isValidId = (id) =>
        (typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id.trim() !== '');
    const isValidStamp = (v) =>
        (typeof v === 'number' && Number.isFinite(v) && v > 0) ||
        (typeof v === 'string' && v.trim() !== '' && (Number.isFinite(Number(v)) || Number.isFinite(Date.parse(v))));

    // Convertit les id d'une liste et renvoie la table ancien id → id final
    function convertList(list, label) {
        const map = new Map();
        const records = list.map(rec => {
            if (!rec || typeof rec !== 'object' || !isValidId(rec.id)) {
                throw new Error(`Identifiant invalide (${label})`);
            }
            if (map.has(rec.id)) throw new Error(`Identifiant en double (${label})`);
            const legacy = typeof rec.id === 'number';
            const id = legacy ? newId() : rec.id;
            map.set(rec.id, id);
            const out = { ...rec, id, updatedAt: isValidStamp(rec.updatedAt) ? rec.updatedAt : 1 };
            if (legacy) out.ancienId = rec.id;
            return out;
        });
        return { map, records };
    }

    const groupsIn = Array.isArray(data.groups) ? data.groups : []; // absent dans les sauvegardes 1.5
    const { map: groupMap, records: groups } = convertList(groupsIn, 'groupe');
    for (const g of groups) {
        if (typeof g.name !== 'string' || !g.name.trim()) throw new Error('Groupe sans nom dans le fichier');
    }

    const { map: gameMap, records: rawGames } = convertList(data.games, 'jeu');
    const games = rawGames.map(game => {
        if (typeof game.name !== 'string' || !game.name.trim() ||
            !Number.isFinite(game.ticketPrice) || game.ticketPrice <= 0) {
            throw new Error(`Jeu invalide : ${game && game.name ? game.name : '?'}`);
        }
        return { ...game, groupId: groupMap.has(game.groupId) ? groupMap.get(game.groupId) : null };
    });

    const { records: rawTickets } = convertList(data.tickets, 'ticket');
    const tickets = rawTickets.map(ticket => {
        const gainOk = ticket.gain === null || ticket.gain === undefined ||
            (Number.isFinite(ticket.gain) && ticket.gain >= 0);
        if (!gainOk) throw new Error('Ticket avec un gain invalide dans le fichier');

        let gameId;
        if (ticket.gameId === null || ticket.gameId === undefined) {
            gameId = null; // ticket orphelin conservé tel quel
        } else if (gameMap.has(ticket.gameId)) {
            gameId = gameMap.get(ticket.gameId);
        } else {
            throw new Error('Ticket rattaché à un jeu absent du fichier');
        }
        return { ...ticket, gameId, gain: ticket.gain === undefined ? null : ticket.gain };
    });

    return { games, tickets, groups };
}

async function importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        // Tout est vérifié AVANT de toucher aux données actuelles
        const incoming = validateImport(JSON.parse(text));
        const { games, tickets, groups } = incoming;

        const confirmed = confirm(
            '⚠️ ATTENTION ⚠️\n\n' +
            `Le fichier contient ${games.length} jeu(x), ${groups.length} groupe(s) et ${tickets.length} ticket(s).\n\n` +
            'L\'import va REMPLACER toutes vos données actuelles, sur cet appareil ET sur tous les appareils ' +
            'synchronisés avec le serveur maison.\n\nVoulez-vous continuer ?'
        );
        if (!confirmed) {
            event.target.value = '';
            return;
        }

        await syncBeforeReplace();
        // Une seule transaction : si quelque chose échoue, rien n'est effacé
        await replaceAllData(incoming);

        showToast('✅ Import réussi !', 'success');
        await loadHomePage();
        await loadSettingsStats();
    } catch (error) {
        console.error('Erreur import:', error);
        showToast('❌ Erreur : ' + (error.message || 'import impossible'), 'error', 4000);
    }

    event.target.value = '';
}

// ==================== Toast ====================
function showToast(message, type = 'info', duration = 2500) {
    document.querySelector('.toast')?.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ==================== Modal de confirmation ====================
function showModal(title, message, onConfirm) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-message').textContent = message;
    document.getElementById('modal').classList.remove('hidden');
    document.getElementById('modal-confirm').onclick = onConfirm;
}

function closeModal() {
    document.getElementById('modal').classList.add('hidden');
}

function isConfirmModalOpen() {
    return !document.getElementById('modal').classList.contains('hidden');
}

// ==================== Utilitaires ====================
const currencyFormatter = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

function formatCurrency(value) {
    return currencyFormatter.format(value || 0);
}

function formatPercent(value) {
    return `${Math.round(value)} %`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML.replace(/"/g, '&quot;');
}

// Argument JavaScript sûr à placer dans un attribut onclick="…" (les id sont des textes)
function jsArg(value) {
    return escapeHtml(JSON.stringify(value === null || value === undefined ? null : String(value)));
}

// ==================== Calcul des Scores ====================
// (logique de classement inchangée par rapport à la 1.5.0)
function calculateScores(ticketCount, totalGains, totalCost, winCount) {
    if (totalCost === 0 || ticketCount === 0) {
        return { balanced: 0, profitability: 0, regularity: 0 };
    }

    const ratio = totalGains / totalCost;
    const winRate = winCount / ticketCount;
    const volumeFactor = Math.log10(ticketCount + 1);
    const reliabilityForBalanced = ticketCount >= 5 ? 1 : Math.pow(ticketCount / 5, 1.5);

    if (winCount === 0) {
        const lossMultiplier = 1 + (ticketCount * 0.1);
        return {
            balanced: (ratio - 1) * 100 * reliabilityForBalanced,
            profitability: (ratio - 1) * 100 * lossMultiplier,
            regularity: -100 * volumeFactor
        };
    }

    return {
        balanced: winRate * (ratio - 1) * 100 * reliabilityForBalanced,
        profitability: (ratio - 1) * 100,
        regularity: winRate * volumeFactor * 100
    };
}

function calculateRankings(gameStats) {
    if (gameStats.length === 0) {
        return { rankings: { byBalanced: [], byProfit: [], byRegular: [] }, globalRanking: [] };
    }

    const gamesWithScores = gameStats.map(game => ({
        ...game,
        scores: calculateScores(game.ticketCount, game.totalGains, game.totalCost, game.winCount || 0),
        confidence: Math.min(game.ticketCount / 5, 1)
    }));

    const byBalanced = [...gamesWithScores].sort((a, b) => b.scores.balanced - a.scores.balanced);
    const byProfit = [...gamesWithScores].sort((a, b) => b.scores.profitability - a.scores.profitability);
    const byRegular = [...gamesWithScores].sort((a, b) => b.scores.regularity - a.scores.regularity);

    const medals = {};
    gameStats.forEach(g => {
        medals[g.id] = { id: g.id, gold: 0, silver: 0, bronze: 0, name: g.name, ticketCount: g.ticketCount, totalScore: 0 };
    });

    // Médailles seulement si le score est positif
    [['balanced', byBalanced], ['profitability', byProfit], ['regularity', byRegular]].forEach(([key, ranking]) => {
        if (ranking[0] && ranking[0].scores[key] > 0) medals[ranking[0].id].gold++;
        if (ranking[1] && ranking[1].scores[key] > 0) medals[ranking[1].id].silver++;
        if (ranking[2] && ranking[2].scores[key] > 0) medals[ranking[2].id].bronze++;
    });

    gamesWithScores.forEach(game => {
        medals[game.id].totalScore = game.scores.balanced + game.scores.profitability + game.scores.regularity;
    });

    const globalRanking = Object.values(medals)
        .map(m => ({ ...m, points: (m.gold * 3) + (m.silver * 2) + m.bronze }))
        .sort((a, b) => {
            if (b.points !== a.points) return b.points - a.points;
            if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
            if (b.gold !== a.gold) return b.gold - a.gold;
            if (b.silver !== a.silver) return b.silver - a.silver;
            return b.bronze - a.bronze;
        });

    return { rankings: { byBalanced, byProfit, byRegular }, globalRanking };
}

// ==================== Page Classement ====================
function showRankingPage() {
    showPage('ranking-page');
    loadRankingPage();
}

function loadRankingPage() {
    const rankings = window.currentRankings;

    if (!rankings || !rankings.globalRanking || rankings.globalRanking.length === 0) {
        document.getElementById('ranking-table-body').innerHTML =
            '<tr><td colspan="4" class="empty-state">Aucune donnée disponible</td></tr>';
        document.getElementById('global-ranking-list').innerHTML =
            '<p class="empty-state">Ajoutez des tickets pour voir le classement</p>';
        return;
    }

    const { byBalanced, byProfit, byRegular } = rankings.rankings;
    const maxRows = Math.max(byBalanced.length, byProfit.length, byRegular.length);

    const displayName = (game) => {
        if (!game) return '-';
        return escapeHtml(game.name) + (game.confidence < 1 ? ' ⚠️' : '');
    };

    let tableHTML = '';
    for (let i = 0; i < maxRows; i++) {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
        tableHTML += `
            <tr>
                <td class="rank-cell">${medal}</td>
                <td>${displayName(byBalanced[i])}</td>
                <td>${displayName(byProfit[i])}</td>
                <td>${displayName(byRegular[i])}</td>
            </tr>
        `;
    }
    document.getElementById('ranking-table-body').innerHTML = tableHTML;

    document.getElementById('global-ranking-list').innerHTML = rankings.globalRanking.map((game, index) => {
        const position = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`;
        const rankClass = index < 3 ? `rank-${index + 1}` : '';
        const confidenceIcon = game.ticketCount < 5 ? ' ⚠️' : '';
        const scoreIndicator = game.totalScore > 0 ? '📈' : game.totalScore < 0 ? '📉' : '➖';

        return `
            <div class="global-rank-item ${rankClass}">
                <span class="rank-position">${position}</span>
                <div class="rank-info">
                    <div class="rank-name">${escapeHtml(game.name)}${confidenceIcon}</div>
                    <div class="rank-medals">🥇${game.gold} 🥈${game.silver} 🥉${game.bronze} · ${scoreIndicator}</div>
                </div>
                <span class="rank-points">${game.points} pts</span>
            </div>
        `;
    }).join('');
}


// ==================== Bouton retour Android (Capacitor) ====================
// Panneau « Serveur maison » (fourni par sync-maison.js dans un shadow DOM)
function closeHomeServerPanel() {
    const panel = [...document.body.children].find(el =>
        el.shadowRoot && el.shadowRoot.querySelector('.fond [aria-label="Serveur maison"]'));
    if (!panel) return false;
    panel.remove();
    return true;
}

function handleBackButton() {
    if (closeHomeServerPanel()) return;
    if (closeTopSheetModal()) return;
    if (isConfirmModalOpen()) return closeModal();

    switch (currentPageId()) {
        case 'home-page': {
            const appPlugin = window.Capacitor?.Plugins?.App;
            if (appPlugin) appPlugin.exitApp();
            return;
        }
        case 'game-detail-page':
            return backFromGameDetail();
        default:
            return goHome();
    }
}

function setupBackButton() {
    const appPlugin = window.Capacitor?.Plugins?.App;
    if (appPlugin && appPlugin.addListener) {
        appPlugin.addListener('backButton', handleBackButton);
    }
}

// ==================== Service worker (version web / GitHub Pages) ====================
function isNativeApp() {
    try {
        return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    } catch {
        return false;
    }
}

function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    if (isNativeApp()) {
        // App Android : les fichiers sont déjà dans l'APK. Un cache ferait réapparaître
        // une ancienne version après une mise à jour : on retire tout service worker.
        navigator.serviceWorker.getRegistrations()
            .then(regs => regs.forEach(reg => reg.unregister()))
            .catch(() => {});
        if (window.caches) {
            caches.keys().then(keys => keys.forEach(key => caches.delete(key))).catch(() => {});
        }
        return;
    }

    navigator.serviceWorker.register('sw.js')
        .catch(err => console.warn('[GRAGA] service worker non enregistré :', err));
}

// ==================== Synchro serveur maison ====================
function setupSync() {
    if (!window.SyncMaison) {
        console.warn('[GRAGA] sync-maison.js non chargé : synchronisation désactivée.');
        return;
    }
    try {
        window.SyncMaison.configurer({
            app: 'graga',
            nom: 'GRAGA',
            mode: 'complet',
            stores: SYNC_STORES,
            toutLire: (store) => runTx([store], 'readonly', t => t.objectStore(store).getAll()),
            appliquer: applySyncChanges
        });
        window.SyncMaison.surEtat(updateSyncStatus);
    } catch (error) {
        console.error('[GRAGA] synchronisation non configurée :', error);
    }
}

// ==================== Initialisation ====================
async function requestPersistentStorage() {
    try {
        if (navigator.storage && navigator.storage.persist) {
            await navigator.storage.persist();
        }
    } catch { /* non pris en charge : sans importance */ }
}

document.addEventListener('DOMContentLoaded', async () => {
    requestPersistentStorage();
    setupServiceWorker();
    try {
        await initDB();
        setupBackButton();
        setupSync();          // ne bloque pas : la synchro démarre en arrière-plan
        await loadHomePage(); // affiche tout de suite les données locales
    } catch (error) {
        console.error('Erreur d\'initialisation:', error);
        alert('Erreur lors du chargement de l\'application. Vos données n\'ont pas été modifiées.');
    }
});
