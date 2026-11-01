console.log("🚀 STARTING BEDROCK AUTO-INVITE BOT (Auto-Accept Version)...");

const bedrock = require('bedrock-protocol');
const { Authflow, Titles } = require('prismarine-auth');
const fetch = require('node-fetch');
const fs = require('fs');

// ================= CONFIG =================
const SERVER_HOST = 'sleepyempire.levyathan.ch'; // Your Bedrock server IP
const SERVER_PORT = 19313; // Your Bedrock server port
const BOT_EMAIL = 'shravan.sktn20@gmail.com'; // The bot's Microsoft account email

const CHECK_INTERVAL_MS = 30000; // Check for new friends every 30 seconds
const SESSION_MINUTES = 120; // Keep alive for 2 hours before cycling
// ==========================================

// ================= WRITABLE CACHE FIX =================
const cacheDir = '/tmp/auth-cache';
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}
// =======================================================

const delay = (min = 1000, max = 4000) => new Promise(r => setTimeout(r, Math.random() * (max - min) + min));

// ================= AUTH FLOW =================
function createAuthflow(email) {
    return new Authflow(email, cacheDir, {
        flow: 'live',
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: 'Nintendo'
    });
}

// ================= FRIENDS & INVITE LOGIC =================
const knownFriendXuids = new Set();

// 1. Fetch the list of people who have added the bot
async function fetchFollowers(authflow) {
    try {
        const token = await authflow.getXboxToken('http://xboxlive.com');
        const res = await fetch('https://peoplehub.xboxlive.com/users/me/people/followers?maxItems=100', {
            headers: {
                'Authorization': `XBL3.0 x=${token.userHash};${token.XSTSToken}`,
                'x-xbl-contract-version': '2',
                'Accept': 'application/json'
            }
        });
        const data = await res.json();
        return data.people || [];
    } catch (err) {
        console.error('❌ Failed to fetch followers:', err.message);
        return [];
    }
}

// 2. Send a game invite to a specific XUID
async function sendInvite(authflow, xuid, gamertag) {
    try {
        const token = await authflow.getXboxToken('https://multiplayer.minecraft.net/');
        console.log(`[Invite] Sending invite to ${gamertag} (XUID: ${xuid})...`);
        
        const res = await fetch(`https://multiplayer.minecraft.net/api/v1/users/${xuid}/invite`, {
            method: 'POST',
            headers: {
                'Authorization': `XBL3.0 x=${token.userHash};${token.XSTSToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                connectionString: `${SERVER_HOST}:${SERVER_PORT}`
            })
        });

        if (res.ok) {
            console.log(`✅ Successfully invited ${gamertag}!`);
        } else {
            const text = await res.text();
            console.log(`❌ Invite failed for ${gamertag}. Status: ${res.status} - ${text}`);
        }
    } catch (err) {
        console.error(`❌ Invite error for ${gamertag}:`, err.message);
    }
}

// 3. NEW: Check for and auto-accept friend requests
async function acceptFriendRequests(authflow) {
    try {
        const token = await authflow.getXboxToken('http://xboxlive.com');
        
        // Fetch incoming friend requests
        const res = await fetch('https://peoplehub.xboxlive.com/users/me/people/friendrequests(received)', {
            headers: {
                'Authorization': `XBL3.0 x=${token.userHash};${token.XSTSToken}`,
                'x-xbl-contract-version': '2',
                'Accept': 'application/json'
            }
        });
        const data = await res.json();
        const requests = data.people || [];

        for (const request of requests) {
            const xuid = request.xuid;
            const gamertag = request.gamertag || request.displayName || 'Unknown';
            
            // Check if we've already processed this request
            if (!knownFriendXuids.has(xuid)) {
                console.log(`👋 New friend request from: ${gamertag} (XUID: ${xuid}). Accepting...`);
                
                // Accept the friend request
                const acceptRes = await fetch(`https://social.xboxlive.com/users/me/people/xuid(${xuid})`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `XBL3.0 x=${token.userHash};${token.XSTSToken}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (acceptRes.ok) {
                    console.log(`✅ Accepted friend request from ${gamertag}`);
                    knownFriendXuids.add(xuid);
                    // Wait a moment for Xbox to register the friendship, then invite
                    await delay(2000, 3000);
                    await sendInvite(authflow, xuid, gamertag);
                } else {
                    console.log(`❌ Failed to accept friend request from ${gamertag}. Status: ${acceptRes.status}`);
                }
            }
        }
    } catch (err) {
        console.error('❌ Error checking friend requests:', err.message);
    }
}

// 4. The loop that watches for new friends and invites them
async function watchForNewFriends(authflow) {
    console.log('[Friends] Starting friend watcher loop...');
    
    // Load existing followers on startup so we don't spam invites to old friends
    const initialFollowers = await fetchFollowers(authflow);
    initialFollowers.forEach(f => knownFriendXuids.add(f.xuid));
    console.log(`[Friends] Loaded ${knownFriendXuids.size} existing followers. Watching for new ones...`);

    while (true) {
        await delay(CHECK_INTERVAL_MS, CHECK_INTERVAL_MS + 5000);
        
        // Check for and auto-accept new friend requests
        await acceptFriendRequests(authflow);
        
        // Also check followers list (for users who added bot as a friend directly)
        const currentFollowers = await fetchFollowers(authflow);
        for (const follower of currentFollowers) {
            if (!knownFriendXuids.has(follower.xuid)) {
                console.log(`👋 New follower detected: ${follower.gamertag || follower.displayName}`);
                knownFriendXuids.add(follower.xuid);
                await sendInvite(authflow, follower.xuid, follower.gamertag || follower.displayName);
            }
        }
    }
}

// ================= BOT MAIN =================
function runBedrockBot(email, host, port) {
    return new Promise(async (resolve) => {
        let client = null;
        let reconnectAttempts = 0;
        const maxReconnectAttempts = 50;
        let isIntentionallyDisconnected = false;
        
        const authflow = createAuthflow(email);

        const startBot = async () => {
            const tag = `[${email}@${host}]`;
            console.log(`${tag} connecting (attempt ${reconnectAttempts + 1}/${maxReconnectAttempts})...`);

            try {
                client = bedrock.createClient({
                    host: host,
                    port: port,
                    username: email,
                    offline: false,
                    authflow: authflow
                });

                client.on('connect', () => {
                    console.log(`${tag} connected to server.`);
                });

                client.on('join', async () => {
                    console.log(`${tag} ✅ spawned and joined the game.`);
                    reconnectAttempts = 0;
                    
                    if (!client.friendWatcherStarted) {
                        client.friendWatcherStarted = true;
                        watchForNewFriends(authflow).catch(err => console.error('Watcher error:', err));
                    }

                    const endTime = Date.now() + SESSION_MINUTES * 60 * 1000;
                    while (Date.now() < endTime && client && !isIntentionallyDisconnected) {
                        await delay(10000, 15000);
                    }
                    
                    isIntentionallyDisconnected = true;
                    if (client) client.disconnect('Session over');
                });

                client.on('error', (err) => console.error(`${tag} error:`, err.message));
                
                client.on('kick', (reason) => {
                    console.log(`⚠️ ${tag} Kicked by server. Reason: ${JSON.stringify(reason)}`);
                });
                
                client.on('close', () => {
                    console.log(`${tag} connection closed.`);
                    if (reconnectAttempts < maxReconnectAttempts && !isIntentionallyDisconnected) {
                        reconnectAttempts++;
                        const wait = Math.min(60000, 5000 * reconnectAttempts);
                        console.log(`${tag} reconnecting in ${Math.round(wait / 1000)}s...`);
                        setTimeout(startBot, wait);
                    } else {
                        console.log(`${tag} ❌ giving up after ${maxReconnectAttempts} attempts or session ended.`);
                        resolve();
                    }
                });

            } catch (error) {
                console.error(`${tag} failed to connect:`, error.message);
                if (reconnectAttempts < maxReconnectAttempts) {
                    reconnectAttempts++;
                    setTimeout(startBot, 10000);
                } else {
                    console.log(`${tag} ❌ giving up after ${maxReconnectAttempts} attempts.`);
                    resolve();
                }
            }
        };

        startBot();
    });
}

// ================= START =================
(async () => {
    await runBedrockBot(BOT_EMAIL, SERVER_HOST, SERVER_PORT);
})();
