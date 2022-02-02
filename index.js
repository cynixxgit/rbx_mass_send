const consola = require('consola');
const config = require('./config.json');
const fetch = require('node-fetch');
const ProxyAgent = require('https-proxy-agent');

// global stuff
let currentUser = {};
const cookieHeader = `.ROBLOSECURITY=${config.cookie};`;

// verifies cookie via roblox's settings api
const verifyCookie = () => new Promise(resolve => {
    fetch('https://roblox.com/my/settings/json', {
        headers: {
            cookie: cookieHeader
        }
    })
    .then(res => res.json())
    .then(body => {
        resolve(body || {});
    })
    .catch(err => {
        if (!err.toString || err.toString().indexOf('NewLogin') === -1)
            consola.error(err);
        else consola.error('Invalid Roblox cookie provided')
        
        resolve({});
    })
});
const getCSRF = () => new Promise(resolve => {
    fetch('https://auth.roblox.com/v1/logout', {
        headers: {
            cookie: cookieHeader
        },
        method: 'POST',
        body: '{}'
    })
    .then(res => {
        resolve(res.headers.get('x-csrf-token') || 'aaaa')
    })
    .catch(err => {
        consola.error(err);
        resolve('aaaa')
    })
})

// rolimons item data
let rolimonsItemCache = {};
const updateRolimonsItemCache = () => new Promise(resolve => {
    fetch('https://www.rolimons.com/itemapi/itemdetails', {
        headers: {
            'user-agent': 'foobmass'
        }
    })
    .then(res => res.json())
    .then(body => {
        rolimonsItemCache = body.items;
        consola.success('Successfully updated Rolimon\'s data cache')
        resolve(rolimonsItemCache);
    })
    .catch(err => {
        consola.error(err);
        resolve(null);
    })
});
let itemNameList = [];
const uaidToItemName = uaid => new Promise(resolve => {
    fetch(`https://www.rolimons.com/uaid/` + uaid, {
        headers: {
            'user-agent': 'foobmass'
        }
    })
    .then(res => res.text())
    .then(body => {
        resolve(body.split(`<h5 class="card-title mb-1 text-light text-truncate stat-data">`)[1].split('</h5>')[0]);
    })
    .catch(() => {
        resolve('Unknown Item');
    })
})
const namify = assetId => rolimonsItemCache[assetId][0].trim();

// converts user id to username
const getUsername = userId => new Promise(resolve => {
    fetch('https://users.roblox.com/v1/users/' + userId)
    .then(res => res.json())
    .then(body => resolve(body.name || 'Unknown'))
    .catch(() => resolve('Unknown'))
})

// trade sending and queue
const sendTrade = body => new Promise(async resolve => {
    const agent = ProxyAgent(`http://${config.proxy}`);
    fetch(`https://trades.roblox.com/v1/trades/send`, {
        agent,
        method: 'POST',
        headers: {
            cookie: cookieHeader,
            'x-csrf-token': await getCSRF(),
            'content-type': 'application/json'
        },
        body: JSON.stringify(body)
    })
    .then(res => res.json())
    .then(resolve)
    .catch(err => {
        consola.error(err);
        resolve({});
    })
});
const tradeQueue = [];
let tradesSent = 0;
const completeQueue = async () => {
    const nextInQueue = tradeQueue.shift();
    if (!nextInQueue) return setTimeout(completeQueue, 100);
    
    // consola.info(`Sending`, nextInQueue)
    const tradeResponse = await sendTrade(nextInQueue);
    if (typeof tradeResponse === 'object') {
        if (tradeResponse.errors) {
            if (tradeResponse.errors[0].code === 0) {
                tradeQueue.push(nextInQueue);
                consola.info(`Ratelimited, retrying.`)
            } else
                consola.info(`Unknown error`, tradeResponse)
        } else if (tradeResponse.id) {
            tradesSent++;
            (async () => {
                const username = await getUsername(nextInQueue.offers[0].userId);
                consola.success(`Trade sent to [${username}] successfully`)
                
                fetch(config.webhook, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        "content": null,
                        "embeds": [
                            {
                                "title": "Trade sent to " + username,
                                "color": 16734383,
                                "fields": [
                                    {
                                        "name": "**Sending**:",
                                        "value": itemNameList.join('\n')
                                    },
                                    {
                                        "name": "**Requesting**:",
                                        "value": itemReceiveNameList.join('\n')
                                    }
                                ],
                                "footer": {
                                    "text": tradeQueue.length.toLocaleString() + " trades in queue, " + tradesSent.toLocaleString() + " sent | delay of 12s"
                                },
                                "thumbnail": {
                                    "url": "https://www.roblox.com/Thumbs/Avatar.ashx?x=200&y=200&Format=Png&username=" + username
                                }
                            }
                        ]
                    })
                })
            })().catch();
        } else {
        }
    } else tradeQueue.push(nextInQueue);
    
    consola.info(`[${tradeQueue.length.toLocaleString()}] trade${tradeQueue.length === 1 ? '' : 's'} in the queue.`);
    
    return setTimeout(completeQueue, 12 * 1000)
}

// checks if a player is able to trade
const checkTradeStatus = userId => new Promise(resolve => {
    fetch(`https://roblox.com/users/${userId}/trade`, {headers: {cookie: cookieHeader}})
    .then(res => {
        resolve(res.status === 200)
    })
    .catch(() => resolve(false));
});

// recursively fetch and handle item owners
const allOwners = {};
const fetchOwners = (assetId, cursor = null) => new Promise(resolve => {
    let url = `https://inventory.roblox.com/v2/assets/${assetId}/owners?limit=100`;
    if (cursor) url += '&cursor=' + cursor;
    
    fetch(url, {headers: {cookie: cookieHeader}})
    .then(res => res.json())
    .then(body => {
        for (const individualAsset of body.data) {
            if (!individualAsset.owner) continue;
            const {id: ownerid} = individualAsset.owner;
            
            if (!allOwners[ownerid])
                allOwners[ownerid] = {};
            if (!allOwners[ownerid][assetId])
                allOwners[ownerid][assetId] = [];
            allOwners[ownerid][assetId].push(individualAsset.id);
        }
        
        if (body.nextPageCursor)
            resolve(fetchOwners(assetId, body.nextPageCursor));
        else resolve(null);
    })
})

// main method for handling the order of functions
let itemReceiveNameList = [];
const main = async () => {
    config.sending = config.sending.slice(0, 4);
    config.receiving = config.receiving.slice(0, 4);
    
    const userdata = await verifyCookie();
    if (!userdata.UserId) return;
    currentUser = userdata;
    
    consola.success(`Logged in as ${userdata.Name} (${userdata.UserId})`);
    
    for (const uaid of config.sending) {
        itemNameList.push(await uaidToItemName(uaid))
        await new Promise(resolve => setTimeout(resolve, 2 * 1000));
    }
    
    const successfulUpdate = await updateRolimonsItemCache();
    if (!successfulUpdate) return;
    
    const fetchPromises = [];
    
    let amountToSendFor = {};
    for (const itemId of config.receiving) {
        fetchPromises.push(new Promise(async resolve => {
            itemReceiveNameList.push(namify(itemId));
            if (amountToSendFor[itemId]) {
                amountToSendFor[itemId]++
                return resolve();
            } else
                amountToSendFor[itemId] = 1;
            
            consola.info(`Finding users with [${namify(itemId)}], please wait...`);
            
            await fetchOwners(itemId);
            consola.success(`Stopped user collection for [${namify(itemId)}]`)
            
            resolve();
        }))
    }
    
    consola.info(`Sending [${itemNameList.join(', ')}] for [${itemReceiveNameList.join(', ')}]`)
    
    await Promise.all(fetchPromises);
    
    completeQueue();
    
    for (let playerId in allOwners) {
        playerId = Number(playerId);
        if (playerId === 1 || playerId === currentUser.UserId) continue;
        
        const playerOwnership = allOwners[playerId];
        let uaidsToSendFor = [];
        let ownsAllItems = true;
        
        let currentPos = {};
        
        for (const itemId of config.receiving) {
            if (!playerOwnership[itemId] || playerOwnership[itemId].length < amountToSendFor[itemId]) {
                ownsAllItems = false;
                break;
            }
            
            if (!currentPos[itemId])
                currentPos[itemId] = 0;
            uaidsToSendFor.push(playerOwnership[itemId][currentPos[itemId]]);
    
            currentPos[itemId]++;
        }
        
        if (!ownsAllItems) continue;
        
        const status = await checkTradeStatus(playerId);
        if (!status) continue
        
        tradeQueue.push({
            offers: [{
                userId: playerId,
                userAssetIds: uaidsToSendFor,
                robux: 0
            }, {
                userId: currentUser.UserId,
                userAssetIds: config.sending,
                robux: 0
            }]
        });
        consola.info(`Queued trade with [${playerId}]`)
    }
}

main();
