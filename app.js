const app = require("express")();
const blocks = require("./blocks");
const http = require("http").Server(app);
const io = require("socket.io")(http);
const R = require("ramda");
const TronWeb = require("tronweb");

let users = 0;

const TRONGRID_API_FULL = "https://api.shasta.trongrid.io";
const TRONGRID_API_SOL = "https://api.shasta.trongrid.io";
const TRONGRID_API_EVENT = "https://api.shasta.trongrid.io";
// const TRONGRID_API_FULL = "http://127.0.0.1:8090";
// const TRONGRID_API_SOL = "http://127.0.0.1:8091";
// const TRONGRID_API_EVENT = "http://127.0.0.1:8092";
const PRIVATE_KEY = "9E503D5C8C3ADD64D539733B15104AFA6C25BA1CF8C6E32E6E409633CB040BD6";
const CONTRACT_ADDRESS = "TKWeF8zjwMQA8TpZQRs5Cj9SXTbargYJFy";

const tronweb = new TronWeb(TRONGRID_API_FULL, TRONGRID_API_SOL, TRONGRID_API_EVENT, PRIVATE_KEY);
const Utils = {
    tronWeb: false,
    contract: false,

    async setTronWeb(tronWeb) {
        this.tronWeb = tronWeb;
        this.contract = tronWeb.contract().at(CONTRACT_ADDRESS);
    },
};

Utils.setTronWeb(tronweb);

const gameLobbies = {};
const playerSeats = [[-7, -7], [0, 7], [7, 0], [7, 7], [0, -7], [-7, 0], [7, -7], [-7, 7]];
const regionPoll = {};
const registrationFee = {
    bronze: 100,
    silver: 500,
    gold: 1000,
    platinum: 5000,
    diamond: 10000,
};

const shuffleSeats = (array) => {
    var currentIndex = array.length;
    var temporaryValue;
    var randomIndex;

    // While there remain elements to shuffle...
    while (0 !== currentIndex) {
        // Pick a remaining element...
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;

        // And swap it with the current element.
        temporaryValue = array[currentIndex];
        array[currentIndex] = array[randomIndex];
        array[randomIndex] = temporaryValue;
    }

    return array;
};
function getGameId(lobby, playerId) {
    const getRandom = (max) => {
        return Math.floor(Math.random() * Math.floor(max));
    };

    const createRoom = () => {
        const _id = +(new Date().getTime() + getRandom(new Date().getTime()));

        return {
            id: _id,
            bombId: 0,
            complete: false,
            count: 0,
            loops: [],
            players: {},
            rankings: null,
            seats: shuffleSeats(playerSeats),
            started: false,
            timeCreated: new Date().getTime(),
        };
    };

    const rooms = R.pathOr({}, [lobby, "rooms"], gameLobbies);
    const keys = Object.keys(rooms);

    console.log("Room String", R.pathOr({}, [lobby, "rooms"], gameLobbies));

    for (let key = 0, id = keys[key]; key < keys.length; key++) {
        const room = rooms[id];

        console.log("Existing Room:", key, "Player ID:", playerId, "Room", room);

        if (room.count < 6 && (!room.started && !room.completed && !room.players[playerId])) {
            console.log("gameLobbies existing:", lobby, Object.keys(gameLobbies[lobby].rooms));

            return room.id;
        }
    }

    const room = createRoom();

    rooms[room.id] = room;
    gameLobbies[lobby] = { rooms: rooms };

    console.log("gameLobbies default:", lobby, Object.keys(gameLobbies[lobby].rooms));

    return room.id;
}

io.on("connection", function(socket) {
    console.log("User Connected: Socket #", socket.id);
    users++;

    socket.on("calculateRankedMatch", function(ranking) {
        const room = R.pathOr(null, [ranking.lobby, "rooms", ranking.room], gameLobbies);
        const players = R.pathOr({}, ["players"], room);

        let timeRanked = null;
        let rankings = R.pathOr(null, ["rankings"], room);

        const broadcastRankings = (_rankings, _loop = false) => {
            console.log("broadcastRankings _rankings:", Object.keys(_rankings));

            const loop = R.pathOr(null, ["loops", 1], room);
            const currentTime = new Date().getTime();
            const timeSinceCreated = timeRanked ? (currentTime - timeRanked) / 1000 / 60 : 0;

            const sortByRanking = R.sortBy(R.compose(R.prop("diePos")));

            if (timeSinceCreated > 0.167 && _loop) {
                const room = R.pathOr(null, [ranking.lobby, "rooms", ranking.room], gameLobbies);

                if (loop.type === "ranking") {
                    clearInterval(loop.loop);
                }

                io.sockets.in(ranking.room).emit("requestRankedMatchResult");
            }

            if (Object.keys(_rankings).length === ranking.totalPlayers) {
                console.log("ranking.totalPlayers", ranking.totalPlayers);

                const room = R.pathOr(null, [ranking.lobby, "rooms", ranking.room], gameLobbies);

                if (loop.type === "ranking") {
                    clearInterval(loop.loop);
                }

                const __rankings = Object.keys(_rankings).map((key) => _rankings[key]);
                const __players = room.players;

                let __totalPlayers = ranking.totalPlayers;
                __rankings.forEach((rank, index) => {
                    if (__totalPlayers !== rank.totalPlayers) {
                        __totalPlayers = null;
                    }
                });

                if (__totalPlayers) {
                    sortByRanking(__rankings).forEach((rank, index) => {
                        const won = rank.diePos === 1 ? 1 : 0;
                        const ptDiff = (__totalPlayers - rank.diePos) * 2;
                        const currentPoints = 0; // @TODO Get from oracle or firestore?
                        const player = __players[rank.id];
                        const rankPos = 0; // @TODO Get from oracle or firestore?

                        io.sockets.to(player.socketID).emit("getRankedMatchResult", {
                            won: won,
                            ptDiff: ptDiff,
                            currentPoints: currentPoints + ptDiff,
                            diePos: rank.diePos,
                            totalPlayers: __totalPlayers,
                            rnkPos: rankPos,
                        });

                        // io.sockets.sockets[player.socketID].disconnect(true);

                        // @TODO - Snapshot room to firestore or blockchain?
                    });

                    const winner = sortByRanking(__rankings)[0];

                    if (Utils.contract) {
                        Utils.contract
                            .then((contract) => {
                                contract
                                    .setWinner(winner.room, winner.id)
                                    .send({ feeLimit:10000, callValue: 0 })
                                    .then((response) => {
                                        setTimeout(() => {
                                            Utils.tronWeb.trx
                                                .getTransaction(response)
                                                .then((response) => {
                                                    if (response.ret) {
                                                        var errors = 0;

                                                        response.ret.forEach((retvalue, index) => {
                                                            if (retvalue.contractRet == "REVERT") {
                                                                errors++;
                                                            }
                                                        });

                                                        if (!errors) {
                                                            io.sockets.to(winner.socketID).emit("payoutSuccess");
                                                        } else {
                                                            io.sockets.to(winner.socketID).emit("payoutFailure");
                                                        }
                                                    } else {
                                                        io.sockets.to(winner.socketID).emit("payoutFailure");
                                                        console.error("No Return");
                                                    }
                                                })
                                                .catch((err) => {
                                                    io.sockets.to(winner.socketID).emit("payoutFailure");
                                                    console.error(err);
                                                });
                                        }, 3500);

                                        return true;
                                    })
                                    .catch((err) => {
                                        io.sockets.to(winner.socketID).emit("payoutFailure");
                                        console.error(err);
                                    });
                            })
                            .catch((err) => {
                                io.sockets.to(winner.socketID).emit("payoutFailure");
                                console.error(err);
                            });
                    } else {
                        io.sockets.to(winner.socketID).emit("payoutFailure");
                        console.log("TronWeb false.");
                    }
                } else {
                    io.sockets.in(ranking.room).emit("contestedRankedMatchResult");
                }
            }
        };

        if (rankings) {
            let player = rankings[ranking.id];

            console.log("rankings, player:", player);

            if (player) {
                const room = R.pathOr(null, [ranking.lobby, "rooms", ranking.room], gameLobbies);
                const loop = R.pathOr(null, ["loops", 1], room);

                if (loop.type === "ranking") {
                    clearInterval(loop.loop);
                }

                io.sockets.in(ranking.room).emit("contestedRankedMatchResult");
            } else {
                player = players[ranking.id];
                rankings[ranking.diePos] = {
                    ...player,
                    ...ranking,
                };

                broadcastRankings(rankings);
            }
        } else {
            let player = players[ranking.id];

            rankings = {};
            rankings[ranking.diePos] = {
                ...player,
                ...ranking,
            };

            if (room) {
                console.log("room found", ranking.room);
                room.rankings = rankings;

                io.sockets.in(ranking.room).emit("matchEnded");

                const loop = {
                    id: ranking.diePos,
                    loop: setInterval(() => {
                        broadcastRankings(rankings, true);
                    }, 3000),
                    type: "ranking",
                };

                room.loops.push(loop);
                timeRanked = new Date().getTime();
            }
        }
    });

    socket.on("destroyBlock", function(block) {
        io.sockets.in(block.room).emit("removeBlock", { room: block.room, id: block.id });
    });

    socket.on("initPlayer", function(token) {
        socket.emit("authenticationSuccess", { curElo: 0, rnkPos: 0 });
    });

    socket.on("joinServer", function(_lobby) {
        const id = _lobby.id;
        const lobby = _lobby.name;
        const rooms = R.pathOr({}, [lobby, "rooms"], gameLobbies);
        const keys = Object.keys(rooms);

        keys.forEach((key, index) => {
            const room = rooms[key];

            if (room.id === id && room.count < 6) {
                room.count++;

                const gamePlayerId = _lobby.playerId;
                const index = room.count - 1;
                const x = room.seats[index][0];
                const z = room.seats[index][1];

                const seatedPlayer = {
                    angleY: 0,
                    availableBombs: 1,
                    currentBombLength: 1,
                    id: gamePlayerId,
                    movement_speed: 3,
                    name: "<span style='color:orange'>0</span> ] " + gamePlayerId.slice(0, 6), // name: "<span style='color:orange'>244</span> ] karega",
                    socketID: socket.id,
                    spawnPoint: {
                        x: x,
                        z: z,
                        isBusy: false,
                    },
                    spawnX: x,
                    spawnZ: z,
                    velocity: 0,
                    x: x,
                    z: z,
                };

                socket.join(id);

                socket.emit("getBlocks", blocks);

                const players = Object.keys(room.players).map((_key) => room.players[_key]);

                socket.emit("getOldPlayers", { oldPlayers: players });

                seatedPlayer.seated = true;

                room.players = Object.assign({ [gamePlayerId]: seatedPlayer }, room.players);

                // gameLobbies[lobby].rooms[key] = room;
                // console.log("Room String", JSON.stringify(gameLobbies[lobby].rooms[key]));

                socket.emit("getId", { id: gamePlayerId });

                io.sockets.in(id).emit("spawnPlayer", { newPlayer: seatedPlayer });

                const getRoomLimit = (timeCreated) => {
                    const currentTime = new Date().getTime();
                    const timeSinceCreated = (currentTime - roomStartTime) / 1000 / 60;

                    let limit = 6;

                    if (timeSinceCreated < 1) {
                        limit = 6;
                    }

                    if (timeSinceCreated > 1) {
                        limit = 4;
                    }

                    if (timeSinceCreated > 1.4) {
                        limit = 2;
                    }

                    if (timeSinceCreated > 4) {
                        limit = -1;
                    }

                    return limit;
                };

                const roomStartTime = room.timeCreated;
                const roomLimit = getRoomLimit(roomStartTime);

                const getServerMessage = (playerCount) => {
                    if (getRoomLimit(roomStartTime) === -1) {
                        console.log("newLobby");
                        io.sockets.in(id).emit("newLobby");
                    } else if (getRoomLimit(roomStartTime) > playerCount) {
                        console.log("Waiting");
                        io.sockets.in(id).emit("serverMessage", {
                            message: "Now Waiting for " + (roomLimit - playerCount) + " Players",
                        });
                    } else if (getRoomLimit(roomStartTime) <= playerCount) {
                        console.log("Started");
                        io.sockets.in(id).emit("serverMessage", { message: "Match Started!" });
                        gameLobbies[lobby].rooms[id].started = true;
                        // @TODO - Snapshot room to firestore or blockchain?

                        const loop = R.pathOr(null, ["loops", 0, "loop"], room);

                        setTimeout(() => {
                            clearInterval(loop);
                        }, 3000);
                    }
                };

                getServerMessage(Object.keys(room.players).length);

                if (!room.loops.length) {
                    const loop = {
                        id: gamePlayerId,
                        loop: setInterval(() => {
                            getServerMessage(Object.keys(room.players).length);
                        }, 15000),
                        type: "message",
                    };

                    room.loops.push(loop);
                }

                return;
            }
        });

        // socket.emit("inQueue", { gameId: id });
    });

    socket.on("latency", function() {
        socket.emit("latency");
    });

    socket.on("leaveRoom", function(player) {
        socket.leave(player.room);
    });

    socket.on("placeBomb", function(bomb) {
        const room = R.pathOr(null, [bomb.lobby, "rooms", bomb.room], gameLobbies);
        const owner = R.pathOr(null, ["players", bomb.id], room);

        io.sockets.in(bomb.room).emit("placeBomb", {
            bomb: {
                id: room.bombId,
                x: bomb.x,
                z: bomb.z,
                owner: owner,
            },
        });

        room.bombId++;
        gameLobbies[bomb.lobby].rooms[bomb.room] = room;
    });

    socket.on("playerDead", function(player) {
        io.sockets.in(player.room).emit("playerDead", { id: player.id });
    });

    socket.on("playerUpdate", function(_player) {
        const room = R.pathOr(null, [_player.lobby, "rooms", _player.room], gameLobbies);

        if (room) {
            const player = room.players[_player.id];

            room.players[player.id] = {
                ...player,
                ..._player,
                angleY: _player.angle,
            };

            const players = Object.keys(room.players).map((key) => room.players[key]);

            io.sockets.in(room.id).emit("playersUpdate", { players: players });
        }
    });

    socket.on("removeBomb", function(bomb) {
        io.sockets.in(bomb.room).emit("removeBomb", {
            id: bomb.id,
            room: bomb.room,
        });
    });

    socket.on("requestLobby", function(_lobby) {
        console.log("Room String", R.pathOr({}, [_lobby.lobby, "rooms"], gameLobbies));

        const lobby = _lobby.lobby;
        const playerId = _lobby.playerId;
        const gameId = getGameId(lobby, playerId);

        if (Utils.contract) {
            Utils.contract
                .then((contract) => {
                    contract
                        .createGame(gameId, registrationFee[lobby], 6)
                        .send({ feeLimit:10000, callValue: 0 })
                        .then((response) => {
                            setTimeout(() => {
                                Utils.tronWeb.trx
                                    .getTransaction(response)
                                    .then((response) => {
                                        if (response.ret) {
                                            var errors = 0;

                                            response.ret.forEach((retvalue, index) => {
                                                if (retvalue.contractRet == "REVERT") {
                                                    errors++;
                                                }
                                            });

                                            if (!errors) {
                                                socket.emit("getGameId", { gameId: gameId });

                                                socket.on("handshake", function() {
                                                    socket.emit("getGameServer", { serverName: gameId });
                                                });
                                            } else {
                                                socket.emit("newLobby", { gameId: gameId, error: "Revert" });
                                                console.error("Revert");
                                            }
                                        } else {
                                            socket.emit("newLobby", { gameId: gameId, error: "No Return" });
                                            console.error("No Return");
                                        }
                                    })
                                    .catch((err) => {
                                        socket.emit("newLobby", { gameId: gameId, error: err });
                                        console.error(err);
                                    });
                            }, 3500);

                            return true;
                        })
                        .catch((err) => {
                            socket.emit("newLobby", { gameId: gameId, error: err });
                            console.error(err);
                        });
                })
                .catch((err) => {
                    socket.emit("newLobby", { gameId: gameId, error: err });
                    console.error(err);
                });
        } else {
            console.log("TronWeb false.");
        }
    });

    socket.on("requestRegions", function() {
        const id = socket.id;

        socket.emit("getRegions", {
            regions: [
                {
                    name: "Wakanda",
                    address: "127.0.0.1",
                    playersCount: 99,
                    updatedSinceLastTime: true,
                },
            ],
        });

        regionPoll[id] = setInterval(function() {
            socket.emit("getRegionsUpdate", {
                regions: [
                    {
                        name: "Wakanda",
                        address: "127.0.0.1",
                        playersCount: 99,
                        updatedSinceLastTime: true,
                    },
                ],
            });

            socket.emit("getPlayersInsideMatches", { count: 42 });
        }, 1800);
    });

    socket.on("disconnect", function() {
        const roomsToNotify = [];

        Object.keys(gameLobbies).map((lobby, _lobby) => {
            Object.keys(gameLobbies[lobby].rooms).map((room, _room) => {
                const matchedSocket = R.pathEq(["socketID"], socket.id);
                const players = gameLobbies[lobby].rooms[room].players;
                const player = R.filter(matchedSocket, players);

                if (Object.keys(player).length) {
                    Object.keys(player).forEach((_player, index) => {
                        delete gameLobbies[lobby].rooms[room].players[_player];

                        roomsToNotify.push({
                            ...player[_player],
                            players: gameLobbies[lobby].rooms[room].players,
                        });
                    });
                }
            });
        });

        roomsToNotify.forEach((player, index) => {
            io.sockets.in(player.room).emit("playerLeave", { id: player.id });

            if (Object.keys(player.players).length < 2) {
                io.sockets.in(player.room).emit("matchEnded");
            }
        });

        console.log("User Disconnected: Socket #", socket.id);
        users--;
    });
});

http.listen(15540, function() {
    console.log("Listening on *:15540");
});
