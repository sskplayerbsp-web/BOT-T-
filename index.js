console.log("🚀 STARTING BEDROCK AUTO-INVITE BOT...");

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
// This prevents the "EROFS: read-only file system" error on Hostless
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
        connectionString: `${SERVER_HOST}:${SERVER_PORT}` // This is the server IP they will join
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

// 3. The loop that watches for new friends and invites them
async function watchForNewFriends(authflow) {
  console.log('[Friends] Starting friend watcher loop...');
  
  // Load existing followers on startup so we don't spam invites to old friends
  const initialFollowers = await fetchFollowers(authflow);
  initialFollowers.forEach(f => knownFriendXuids.add(f.xuid));
  console.log(`[Friends] Loaded ${knownFriendXuids.size} existing followers. Watching for new ones...`);

  while (true) {
    await delay(CHECK_INTERVAL_MS, CHECK_INTERVAL_MS + 5000);
    const currentFollowers = await fetchFollowers(authflow);

    for (const follower of currentFollowers) {
      if (!knownFriendXuids.has(follower.xuid)) {
        console.log(`👋 New friend detected: ${follower.gamertag || follower.displayName}`);
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
    let isIntentionallyDisconnected = false;
    
    const authflow = createAuthflow(email);

    const startBot = async () => {
      const tag = `[${email}@${host}]`;
      console.log(`${tag} connecting (attempt ${reconnectAttempts + 1})...`);

      try {
        client = bedrock.createClient({
          host: host,
          port: port,
          username: email,
          offline: false, // Use Microsoft authentication
          authflow: authflow
        });

        client.on('connect', () => {
          console.log(`${tag} connected to server.`);
          reconnectAttempts = 0;
        });

        client.on('join', async () => {
          console.log(`${tag} ✅ spawned and joined the game.`);
          
          // Start the friend watcher loop only once
          if (!client.friendWatcherStarted) {
            client.friendWatcherStarted = true;
            watchForNewFriends(authflow).catch(err => console.error('Watcher error:', err));
          }

          // Keep the bot online for SESSION_MINUTES, then cycle
          const endTime = Date.now() + SESSION_MINUTES * 60 * 1000;
          while (Date.now() < endTime && client && !isIntentionallyDisconnected) {
            await delay(10000, 15000); // Just idle and keep the connection alive
          }
          
          isIntentionallyDisconnected = true;
          if (client) client.disconnect('Session over');
        });

        client.on('error', (err) => console.error(`${tag} error:`, err.message));
        client.on('kick', (reason) => console.log(`${tag} kicked: ${reason}`));
        
        client.on('close', () => {
          console.log(`${tag} connection closed.`);
          if (reconnectAttempts < 10 && !isIntentionallyDisconnected) {
            reconnectAttempts++;
            const wait = Math.min(60000, 5000 * reconnectAttempts);
            console.log(`${tag} reconnecting in ${Math.round(wait / 1000)}s...`);
            setTimeout(startBot, wait);
          } else {
            console.log(`${tag} ❌ giving up or session ended.`);
            resolve();
          }
        });

      } catch (error) {
        console.error(`${tag} failed:`, error.message);
        if (reconnectAttempts < 10) {
          reconnectAttempts++;
          setTimeout(startBot, 10000);
        } else {
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
