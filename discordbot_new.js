require('dotenv').config();

// discordbot.js
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, entersState, VoiceConnectionStatus, StreamType } = require('@discordjs/voice');
const { spawn } = require('child_process');
const search = require('youtube-search'); // 유튜브 검색 추가
// const sodium = require('libsodium-wrappers'); // @discordjs/voice v0.8.0 이상에서는 libsodium-wrappers/sodium 대신 sodium-native 또는 tweetnacl 권장

// const { token, youtubeApiKey, ffmpegPath: configFfmpegPath, ytDlpPath: configYtDlpPath } = require('./discordConfig.js'); // 설정 파일에서 경로 가져오기
const token = process.env.DISCORD_TOKEN;
const youtubeApiKey = process.env.YOUTUBE_API_KEY;
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ytDlpPath = process.env.YT_DLP_PATH || 'yt-dlp';

// 경로 설정: 설정 파일 > 환경 변수 > 기본값 순으로 우선순위
// const ytDlpPath = process.env.YT_DLP_PATH || configYtDlpPath || 'yt-dlp'; // 시스템 PATH에 yt-dlp가 설정되어 있다면 'yt-dlp'로 사용 가능
// const ffmpegPath = process.env.FFMPEG_PATH || configFfmpegPath || 'ffmpeg'; // 시스템 PATH에 ffmpeg가 설정되어 있다면 'ffmpeg'로 사용 가능

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const youtubeSearchOptions = {
    maxResults: 1,
    key: youtubeApiKey,
    type: 'video'
};

// 전역 상태 변수
let guildQueues = new Map(); // 서버(guild)별 큐 관리

// 서버별 큐 객체 구조
/*
guildQueues.set(guildId, {
    voiceChannel: null,
    connection: null,
    player: null,
    playList: [],         // { url, title, thumbnail, requestedBy }
    currentIndex: 0,
    isPlaying: false,
    isRepeating: false,
    embedMessage: null,
    currentYtDlpProcess: null,
    currentFfmpegProcess: null,
    currentAudioResource: null,
    messageChannel: null // 마지막 명령어가 입력된 채널 (응답용)
});
*/

client.on('ready', () => {
    console.log(`${client.user.tag} 에 로그인됨`);
    // libsodium-wrappers 로딩 (필요한 경우 - @discordjs/voice 버전에 따라)
    // (async () => {
    //     try {
    //         await sodium.ready;
    //         console.log('libsodium 로드 완료');
    //     } catch (err) {
    //         console.error('libsodium 로드 실패:', err);
    //     }
    // })();
});

const prefix = '!';

client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    let queue = guildQueues.get(message.guild.id);
    if (!queue && ['재생', '넘기기', '컷', '중지', '재생목록', '삭제', '반복재생', '초기화'].includes(command)) {
        // 기본 큐 객체 생성
        queue = {
            voiceChannel: null,
            connection: null,
            player: null,
            playList: [],
            currentIndex: 0,
            isPlaying: false,
            isRepeating: false,
            embedMessage: null,
            currentYtDlpProcess: null,
            currentFfmpegProcess: null,
            currentAudioResource: null,
            messageChannel: message.channel // 메시지 채널 저장
        };
        guildQueues.set(message.guild.id, queue);
    } else if (queue) {
        queue.messageChannel = message.channel; // 항상 최신 메시지 채널로 업데이트
    }


    if (command === '재생') {
        const query = args.join(' ');
        if (!query) {
            return message.reply('재생할 노래 제목이나 URL을 입력하세요.');
        }

        queue.voiceChannel = message.member.voice.channel;
        if (!queue.voiceChannel) {
            return message.reply('먼저 음성 채널에 참여해주세요.');
        }

        const permissions = queue.voiceChannel.permissionsFor(message.client.user);
        if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)){
            return message.reply('음성 채널에 연결하거나 말할 권한이 없습니다.');
        }

        // play-dl과 같은 라이브러리 없이 직접 URL을 처리하거나 Youtube를 사용
        // URL 패턴 감지 (간단한 형태)
        if (query.startsWith('http://') || query.startsWith('https://')) {
            // 직접 URL을 사용하는 경우, 제목/썸네일은 yt-dlp -j 옵션 등으로 가져올 수 있으나, 여기서는 URL 자체를 제목으로 사용
            const song = {
                url: query,
                title: query, // 추후 yt-dlp로 정보 가져와서 업데이트 가능
                thumbnail: '', // 추후 yt-dlp로 정보 가져와서 업데이트 가능
                requestedBy: message.author.tag
            };
            queue.playList.push(song);
            message.reply(`"${song.title}"이(가) 재생 목록에 추가되었습니다.`);
        } else {
            // Youtube 사용
            search(query, youtubeSearchOptions, async (err, results) => {
                if (err) {
                    console.error('[DEBUG] YouTube 검색 오류:', err);
                    return message.reply('노래 검색 중 오류가 발생했습니다.');
                }
                if (!results || results.length === 0) {
                    return message.reply('검색 결과가 없습니다.');
                }
                const result = results[0];
                const song = {
                    url: result.link,
                    title: result.title,
                    thumbnail: result.thumbnails.default.url,
                    requestedBy: message.author.tag
                };
                queue.playList.push(song);
                message.reply(`"${song.title}"이(가) 재생 목록에 추가되었습니다.`);

                if (!queue.isPlaying) {
                    await playNext(message.guild.id);
                } else if (queue.embedMessage && (queue.playList.length % 5 === 0 || queue.playList.length === 1)) {
                    // 목록 업데이트 시 embed 메시지 재전송 (선택적)
                    // await sendOrUpdateEmbed(message.guild.id);
                }
            });
        }

        if (!queue.isPlaying) {
            await playNext(message.guild.id);
        } else if (queue.embedMessage && (queue.playList.length % 5 === 0 || queue.playList.length === 1)) {
             // await sendOrUpdateEmbed(message.guild.id);
        }

    } else if (command === '넘기기') {
        if (!queue || !queue.player || queue.playList.length === 0) {
            return message.reply('재생 중인 노래가 없거나 재생 목록이 비어있습니다.');
        }
        if (queue.connection && queue.connection.state.status === VoiceConnectionStatus.Ready && queue.player.state.status !== AudioPlayerStatus.Idle) {
            message.reply('⏩ 다음 곡으로 넘어갑니다...');
            queue.player.stop(true); // Idle 이벤트 트리거 -> playNext 호출됨
        } else {
            message.reply('플레이어가 준비되지 않았거나 이미 다음 곡으로 넘어가는 중입니다.');
        }

    } else if (command === '컷' || command === '중지') {
        if (!queue || !queue.connection) {
            return message.reply('봇이 음성 채널에 없습니다.');
        }
        message.reply('⏹️ 재생을 중지하고 음성 채널을 나갑니다.');
        await leaveChannel(message.guild.id);

    } else if (command === '재생목록') {
        if (!queue || queue.playList.length === 0) {
            return message.reply('재생 목록이 비어있습니다.');
        }
        let response = '🎶 현재 재생 목록:\n';
        queue.playList.forEach((song, index) => {
            response += `[${index + 1}] ${song.title} (요청: ${song.requestedBy})\n`;
        });
        // 현재 곡 표시
        if (queue.isPlaying && queue.playList[queue.currentIndex]) {
            response += `\n▶️ 현재 재생 중: ${queue.playList[queue.currentIndex].title}`;
        }
        message.reply(response);

    } else if (command === '삭제') {
        if (!queue || queue.playList.length === 0) {
            return message.reply('삭제할 곡이 재생 목록에 없습니다.');
        }
        const indexToRemove = parseInt(args[0], 10) - 1; // 사용자 입력은 1부터 시작
        if (isNaN(indexToRemove) || indexToRemove < 0 || indexToRemove >= queue.playList.length) {
            return message.reply('잘못된 번호입니다. 재생 목록 번호를 확인해주세요.');
        }

        const removedSong = queue.playList.splice(indexToRemove, 1)[0];
        message.reply(`"${removedSong.title}"이(가) 재생 목록에서 삭제되었습니다.`);

        if (indexToRemove === queue.currentIndex) {
            // 현재 재생 중인 곡을 삭제한 경우
            if (queue.isPlaying) {
                queue.player.stop(true); // 다음 곡 재생 (또는 목록 비었으면 종료)
            }
        } else if (indexToRemove < queue.currentIndex) {
            queue.currentIndex--; // 삭제된 곡 이전의 곡 인덱스 조정
        }
        // await sendOrUpdateEmbed(message.guild.id); // 목록 변경 시 Embed 업데이트


    } else if (command === '반복재생') {
        // if (!queue) return message.reply('먼저 노래를 재생해주세요.');
        // queue.isRepeating = !queue.isRepeating;
        // message.reply(`🔁 반복 재생이 ${queue.isRepeating ? '켜졌습니다' : '꺼졌습니다'}.`);
        // await sendOrUpdateEmbed(message.guild.id);

    } else if (command === '초기화') {
        if (!queue) return message.reply('초기화할 재생 목록이 없습니다.');
        queue.playList = [];
        queue.currentIndex = 0;
        if (queue.isPlaying && queue.player) {
            queue.player.stop(true); // 재생 중지
        }
        queue.isPlaying = false;
        message.reply('재생 목록이 초기화되었습니다.');
        await sendOrUpdateEmbed(message.guild.id); // Embed 초기화
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const guildId = interaction.guildId;
    let queue = guildQueues.get(guildId);

    if (!queue) {
        // 기본 큐 객체 생성 (버튼 인터랙션 시에도 필요할 수 있음)
        queue = {
            voiceChannel: interaction.member?.voice?.channel, // 버튼 클릭 사용자의 음성 채널
            connection: null,
            player: null,
            playList: [],
            currentIndex: 0,
            isPlaying: false,
            isRepeating: false,
            embedMessage: null,
            currentYtDlpProcess: null,
            currentFfmpegProcess: null,
            currentAudioResource: null,
            messageChannel: interaction.channel // 인터랙션 발생 채널
        };
        guildQueues.set(guildId, queue);
    } else {
         queue.messageChannel = interaction.channel; // 항상 최신 채널로 업데이트
    }

    const { customId } = interaction;

    if (customId === 'skip') {
        if (!queue.player || queue.playList.length === 0) {
            return interaction.reply({ content: '재생 중인 노래가 없거나 재생 목록이 비어있습니다.', ephemeral: true });
        }
        if (queue.connection && queue.connection.state.status === VoiceConnectionStatus.Ready && queue.player.state.status !== AudioPlayerStatus.Idle) {
            await interaction.reply({ content: '⏩ 다음 곡으로 넘어갑니다!', ephemeral: true });
            queue.player.stop(true);
        } else {
            await interaction.reply({ content: '플레이어가 준비되지 않았거나 이미 다음 곡으로 넘어가는 중입니다.', ephemeral: true });
        }
    } else if (customId === 'songList') {
        if (queue.playList.length === 0) {
            return interaction.reply({ content: '재생 목록이 비어있습니다.', ephemeral: true });
        }
        let response = '🎶 현재 재생 목록:\n';
        queue.playList.forEach((song, index) => {
            response += `[${index + 1}] ${song.title} (요청: ${song.requestedBy})\n`;
        });
        if (queue.isPlaying && queue.playList[queue.currentIndex]) {
            response += `\n▶️ 현재 재생 중: ${queue.playList[queue.currentIndex].title}`;
        }
        await interaction.reply({ content: response, ephemeral: true });
    } else if (customId === 'stop') {
        if (!queue.connection) {
            return interaction.reply({ content: '봇이 음성 채널에 없습니다.', ephemeral: true });
        }
        await interaction.reply({ content: '⏹️ 재생을 중지하고 음성 채널을 나갑니다.', ephemeral: true });
        await leaveChannel(guildId);
    } else if (customId === 'loop') {
        queue.isRepeating = !queue.isRepeating;
        await interaction.deferUpdate(); // 버튼 상태 변경 없이 UI 업데이트만 알림
        await sendOrUpdateEmbed(guildId); // Embed 업데이트하여 반복 상태 표시
    }
});


/**
 * 노래 재생
 * @param {*} guildId 접속서버 고유ID
 * @returns 
 */
async function playNext(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue) return;

    // 이전 곡 완료 시 index 증가 추가
    if (queue.isPlaying && queue.playList.length > 0) {
        queue.currentIndex++;
        if (queue.currentIndex >= queue.playList.length && queue.isRepeating) {
            queue.currentIndex = 0;
        }
    }

    if (queue.playList.length === 0) {
        queue.isPlaying = false;
        await sendOrUpdateEmbed(guildId, '재생중인 노래가 없습니다', '', '', `Music Bot (반복재생 ${queue.isRepeating ? 'on' : 'off'})`);
        return;
    }

    if (queue.currentIndex >= queue.playList.length) {
        if (queue.isRepeating) {
            queue.currentIndex = 0;
        } else {
            queue.isPlaying = false;
            await sendOrUpdateEmbed(guildId, '재생 목록 완료', '', '', `Music Bot (반복재생 ${queue.isRepeating ? 'on' : 'off'})`);
            return;
        }
    }

    queue.isPlaying = true;
    const song = queue.playList[queue.currentIndex];

    console.log(`[DEBUG][${guildId}] 다음 곡 재생 시도: ${song.title} (${song.url})`);

    try {
        // ===== 음성 채널 연결 - 상세 디버깅 추가 =====
        if (!queue.connection || 
            queue.connection.state.status === VoiceConnectionStatus.Destroyed || 
            queue.connection.state.status === VoiceConnectionStatus.Disconnected) {
            
            if (!queue.voiceChannel) {
                console.warn(`[DEBUG][${guildId}] voiceChannel 정보가 없습니다.`);
                queue.isPlaying = false;
                if (queue.messageChannel) {
                    queue.messageChannel.send('음성 채널 정보를 찾을 수 없습니다. 다시 시도해주세요.').catch(console.error);
                }
                return;
            }
            
            // 권한 체크 추가
            const permissions = queue.voiceChannel.permissionsFor(client.user);
            console.log(`[DEBUG][${guildId}] 봇 권한:`, {
                connect: permissions.has(PermissionFlagsBits.Connect),  
                speak: permissions.has(PermissionFlagsBits.Speak),      
                viewChannel: permissions.has(PermissionFlagsBits.ViewChannel) 
            });
            
            console.log(`[DEBUG][${guildId}] 음성 채널 연결 시도 - Channel: ${queue.voiceChannel.name} (${queue.voiceChannel.id})`);
            
            queue.connection = joinVoiceChannel({
                channelId: queue.voiceChannel.id,
                guildId: guildId,
                adapterCreator: client.guilds.cache.get(guildId).voiceAdapterCreator,
            });
            
            console.log(`[DEBUG][${guildId}] joinVoiceChannel 호출 완료. 초기 상태: ${queue.connection.state.status}`);
            
            setupConnectionEventHandlers(guildId);
            
            // 상태 변화 모니터링
            const stateLogger = (oldState, newState) => {
                console.log(`[DEBUG][${guildId}] 🔄 Connection 상태 변화: ${oldState.status} → ${newState.status}`);
            };
            queue.connection.on('stateChange', stateLogger);
            
            // Ready 대기 (더 긴 타임아웃 + 상세 로그)
            try {
                console.log(`[DEBUG][${guildId}] Ready 상태 대기 시작... (최대 30초)`);
                await entersState(queue.connection, VoiceConnectionStatus.Ready, 30_000);
                console.log(`[DEBUG][${guildId}] ✅ Ready 상태 도달 성공`);
                queue.connection.off('stateChange', stateLogger);
            } catch (error) {
                console.error(`[DEBUG][${guildId}] ❌ Ready 상태 도달 실패`);
                console.error(`[DEBUG][${guildId}] 최종 상태: ${queue.connection.state.status}`);
                console.error(`[DEBUG][${guildId}] 에러 상세:`, error);
                queue.connection.off('stateChange', stateLogger);
                
                queue.isPlaying = false;
                if (queue.messageChannel) {
                    queue.messageChannel.send(
                        `음성 채널 연결에 실패했습니다.\n` +
                        `현재 상태: ${queue.connection.state.status}\n` +
                        `봇의 음성 채널 권한을 확인해주세요.`
                    ).catch(console.error);
                }
                
                if (queue.connection) queue.connection.destroy();
                return;
            }
            
        } else if ([VoiceConnectionStatus.Signalling, VoiceConnectionStatus.Connecting].includes(queue.connection.state.status)) {
            console.log(`[DEBUG][${guildId}] 기존 연결이 진행 중. 현재 상태: ${queue.connection.state.status}`);
            
            try {
                console.log(`[DEBUG][${guildId}] Ready 상태 대기 시작... (최대 20초)`);
                await entersState(queue.connection, VoiceConnectionStatus.Ready, 20_000);
                console.log(`[DEBUG][${guildId}] ✅ Ready 상태 도달 성공`);
            } catch (error) {
                console.error(`[DEBUG][${guildId}] ❌ Ready 상태 도달 실패 (재연결 대기 중)`);
                console.error(`[DEBUG][${guildId}] 최종 상태: ${queue.connection.state.status}`);
                
                queue.isPlaying = false;
                if (queue.messageChannel) {
                    queue.messageChannel.send('음성 채널 연결 대기 중 타임아웃이 발생했습니다.').catch(console.error);
                }
                
                if (queue.connection) queue.connection.destroy();
                return;
            }
        }

        console.log(`[DEBUG][${guildId}] 스트리밍 준비 시작...`);

        // ===== yt-dlp 프로세스 생성 =====
        queue.currentYtDlpProcess = spawn(ytDlpPath, [
            '-f', 'bestaudio[ext=opus]/bestaudio/best',
            '--no-playlist',
            '--no-progress',
            song.url,
            '-o', '-'
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        // ===== ffmpeg 프로세스 생성 =====
        queue.currentFfmpegProcess = spawn(ffmpegPath, [
            '-i', 'pipe:0',
            '-analyzeduration', '0',
            '-loglevel', 'error',
            '-f', 'opus',
            '-ar', '48000',
            '-ac', '2',
            '-b:a', '96k',
            'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        // ===== 오류 로깅 =====
        queue.currentYtDlpProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg.includes('ERROR') || msg.includes('WARNING')) {
                console.error(`[YT-DLP][${guildId}]: ${msg}`);
            }
        });
        
        queue.currentFfmpegProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg && !msg.includes('size=') && !msg.includes('time=')) {
                console.error(`[FFMPEG][${guildId}]: ${msg}`);
            }
        });

        // ===== 파이핑 =====
        queue.currentYtDlpProcess.stdout.pipe(queue.currentFfmpegProcess.stdin);

        // ===== 스트림 오류 처리 =====
        let isCleaningUp = false;
        const handleStreamError = async (source, err) => {
            console.error(`[${source} ERROR][${guildId}]:`, err.message);
            if (!isCleaningUp) {
                isCleaningUp = true;
                await cleanupCurrentStreamAndProcesses(guildId);
            }
        };

        queue.currentYtDlpProcess.stdout.on('error', (err) => handleStreamError('YT-DLP STDOUT', err));
        queue.currentFfmpegProcess.stdin.on('error', (err) => handleStreamError('FFMPEG STDIN', err));
        queue.currentFfmpegProcess.stdout.on('error', (err) => handleStreamError('FFMPEG STDOUT', err));

        // ===== AudioResource 생성 =====
        queue.currentAudioResource = createAudioResource(queue.currentFfmpegProcess.stdout, {
            inputType: StreamType.OggOpus,
            inlineVolume: true
        });

        if (!queue.player) {
            console.log(`[DEBUG][${guildId}] 오디오 플레이어 생성`);
            queue.player = createAudioPlayer();
            setupPlayerEventHandlers(guildId);
        }

        // ===== 재생 시작 =====
        console.log(`[DEBUG][${guildId}] 재생 시작 - Connection 상태: ${queue.connection.state.status}`);
        queue.connection.subscribe(queue.player);
        queue.player.play(queue.currentAudioResource);
        
        console.log(`[DEBUG][${guildId}] ✅ 재생 명령 완료`);
        await sendOrUpdateEmbed(guildId);

    } catch (error) {
        console.error(`[DEBUG][${guildId}] 💥 playNext 오류:`, error.message);
        console.error(`[DEBUG][${guildId}] 오류 스택:`, error.stack);
        
        queue.isPlaying = false;
        if (queue.messageChannel) {
            queue.messageChannel.send(`노래 재생 중 오류: ${error.message}`).catch(console.error);
        }
        await cleanupCurrentStreamAndProcesses(guildId);
    }
}

/**
 * 서버 연결
 * @param {*} guildId 
 * @returns 
 */
function setupConnectionEventHandlers(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue || !queue.connection) return;

    queue.connection.on('stateChange', (oldState, newState) => {
        console.log(`[Voice Connection][${guildId}] State changed from ${oldState.status} to ${newState.status}`);
    });
    
    queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        console.warn(`[DEBUG][${guildId}] 음성 연결 끊어짐. 재연결 시도...`);
        try {
            await Promise.race([
                entersState(queue.connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(queue.connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch (error) {
            console.error(`[DEBUG][${guildId}] 음성 연결 재연결 실패. 채널 나감.`, error);
            if (queue.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                // leaveChannel(guildId); // 여기서 바로 나가면 재시도 로직과 충돌 가능성
                queue.connection.destroy(); // 명시적으로 연결 파괴
            }
        }
    });

    queue.connection.on(VoiceConnectionStatus.Destroyed, () => {
        console.log(`[DEBUG][${guildId}] 음성 연결 완전 파괴됨.`);
        // 여기서 leaveChannel을 호출하면 무한 루프에 빠질 수 있으므로 주의
        // leaveChannel은 사용자가 명시적으로 나가거나, 모든 작업 완료 후 호출되도록
        cleanupGuildQueue(guildId, false); // 연결만 끊어진 경우, 큐는 유지하되 connection 관련만 정리
    });
}

/**
 * 오디오 플레이어 세팅
 * @param {*} guildId 
 * @returns 
 */
function setupPlayerEventHandlers(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue || !queue.player) return;

    queue.player.on(AudioPlayerStatus.Idle, async () => {
        console.log(`[DEBUG][${guildId}] 🎶 AudioPlayer 상태 Idle (곡: ${queue.playList[queue.currentIndex]?.title}) - 다음 곡 준비`);
        await cleanupCurrentStreamAndProcesses(guildId); // 현재 스트림/프로세스 정리 *중요*

        if (queue.currentIndex < queue.playList.length -1 || queue.isRepeating) {
            await playNext(guildId);
        } else {
            queue.currentIndex++;
            queue.isPlaying = false;
            await sendOrUpdateEmbed(guildId, '재생 목록 완료', '', '', `Music Bot (반복재생 ${queue.isRepeating ? 'on' : 'off'})`);
             // 모든 곡 재생 완료 후 자동으로 나갈지 여부
            // setTimeout(() => {
            //    if (queue && !queue.isPlaying && queue.connection) leaveChannel(guildId);
            // }, 300000); // 5분
        }
    });

    queue.player.on(AudioPlayerStatus.Playing, () => {
        console.log(`[DEBUG][${guildId}] ▶️ AudioPlayer 상태 Playing (곡: ${queue.playList[queue.currentIndex]?.title})`);
        queue.isPlaying = true; // 확실하게 상태 업데이트
    });

    queue.player.on('error', async (error) => {
        console.error(`[DEBUG][${guildId}] 💥 AudioPlayer Error (곡: ${queue.playList[queue.currentIndex]?.title}):`, error.message);
        await cleanupCurrentStreamAndProcesses(guildId); // 오류 시에도 스트림 정리

        if (queue.messageChannel) {
            queue.messageChannel.send(`현재 곡 재생 중 오류 발생: ${error.message}.`).catch(console.error);
        }
        // 오류 발생 시 다음 곡 자동 시도 (선택적)
        if (queue.currentIndex < queue.playList.length - 1 || queue.isRepeating) {
            if (queue.messageChannel) queue.messageChannel.send('다음 곡을 시도합니다.').catch(console.error);
            queue.currentIndex++;
            await playNext(guildId);
        } else {
            queue.isPlaying = false;
            await sendOrUpdateEmbed(guildId, '오류 발생 후 재생 목록 종료', '', '', `Music Bot (반복재생 ${queue.isRepeating ? 'on' : 'off'})`);
        }
    });
}

/**
 * 현재 오디오 종료 및 제거
 * @param {*} guildId 
 * @returns 
 */
async function cleanupCurrentStreamAndProcesses(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue) return;
    console.log(`[DEBUG][${guildId}] cleanupCurrentStreamAndProcesses 호출됨`);

    const processesToKill = [];
    if (queue.currentYtDlpProcess) processesToKill.push(queue.currentYtDlpProcess);
    if (queue.currentFfmpegProcess) processesToKill.push(queue.currentFfmpegProcess);

    for (const proc of processesToKill) {
        if (proc.stdout && !proc.stdout.destroyed) {
            proc.stdout.unpipe(); // 연결된 파이프 해제
            proc.stdout.destroy();
        }
        if (proc.stdin && !proc.stdin.destroyed) {
            proc.stdin.end(); // 정상 종료 유도
        }
        if (proc.stderr && !proc.stderr.destroyed) {
            proc.stderr.destroy();
        }
        if (!proc.killed) {
            try {
                // SIGTERM으로 먼저 시도, 안되면 SIGKILL
                proc.kill('SIGTERM');
                await new Promise(resolve => setTimeout(resolve, 200)); // 잠깐 대기
                if (!proc.killed) {
                    proc.kill('SIGKILL');
                    console.log(`[DEBUG][${guildId}] Process (PID: ${proc.pid}) SIGKILL로 종료`);
                } else {
                    console.log(`[DEBUG][${guildId}] Process (PID: ${proc.pid}) SIGTERM으로 종료`);
                }
            } catch(e){
                console.warn(`[DEBUG][${guildId}] Process (PID: ${proc.pid}) 종료 중 오류: ${e.message}`);
                 if (!proc.killed) proc.kill('SIGKILL'); // 최후의 수단
            }
        }
    }
    
    queue.currentYtDlpProcess = null;
    queue.currentFfmpegProcess = null;
    if (queue.currentAudioResource) {
        // queue.currentAudioResource.playStream?.destroy(); // 리소스 내부 스트림은 player.stop()에서 처리될 수 있음
        queue.currentAudioResource = null;
    }
    console.log(`[DEBUG][${guildId}] 스트림 및 프로세스 정리 완료`);
}

/**
 * gui 생성 및 갱신
 * @param {*} guildId 
 * @param {*} titleOverride 곡 제목
 * @param {*} descOverride 곡 설명
 * @param {*} thumbOverride 썸네일
 * @param {*} footerOverride 하단 공통 gui
 * @returns 
 */
async function sendOrUpdateEmbed(guildId, titleOverride = null, descOverride = null, thumbOverride = null, footerOverride = null) {
    const queue = guildQueues.get(guildId);
    if (!queue || !queue.messageChannel) return; // 메시지 채널 없으면 전송 불가

    const currentSong = queue.playList[queue.currentIndex];
    let embedTitle = titleOverride || (queue.isPlaying && currentSong ? '현재 재생 중' : '재생 대기 중');
    let embedDesc = descOverride || (queue.isPlaying && currentSong ? `**${currentSong.title}**\n요청: ${currentSong.requestedBy}` : '명령어를 사용해 노래를 추가하세요.');
    let embedThumbnail = thumbOverride || (queue.isPlaying && currentSong ? currentSong.thumbnail : null);
    let embedFooter = footerOverride || `Music Bot | 반복 재생: ${queue.isRepeating ? 'ON' : 'OFF'} | ${queue.playList.length} 곡 대기 중`;

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle(embedTitle)
        .setDescription(embedDesc)
        .setFooter({ text: embedFooter });

    if (embedThumbnail) {
        embed.setThumbnail(embedThumbnail);
    }

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('skip').setLabel('넘기기').setStyle(ButtonStyle.Success).setDisabled(!queue.isPlaying || queue.playList.length === 0),
            new ButtonBuilder().setCustomId('songList').setLabel('재생목록').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('stop').setLabel('컷').setStyle(ButtonStyle.Danger).setDisabled(!queue.connection),
            new ButtonBuilder().setCustomId('loop').setLabel(queue.isRepeating ? '반복끄기' : '반복켜기').setStyle(ButtonStyle.Secondary)
        );

    try {
        if (queue.embedMessage && !queue.embedMessage.deleted) {
            await queue.embedMessage.edit({ embeds: [embed], components: [row] });
        } else {
            const sentMessage = await queue.messageChannel.send({ embeds: [embed], components: [row] });
            queue.embedMessage = sentMessage;
        }
    } catch (error) {
        console.error(`[DEBUG][${guildId}] Embed 메시지 전송/수정 오류:`, error);
        if (error.code === 10008 && queue.embedMessage) { // Unknown Message
            console.log(`[DEBUG][${guildId}] 이전 Embed 메시지를 찾을 수 없어 새로 전송합니다.`);
            queue.embedMessage = null; // 참조 초기화
            const sentMessage = await queue.messageChannel.send({ embeds: [embed], components: [row] }).catch(console.error);
            queue.embedMessage = sentMessage;
        }
    }
}

/**
 * 채널 나가기
 * @param {*} guildId 
 * @returns 
 */
async function leaveChannel(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue) return;
    console.log(`[DEBUG][${guildId}] 음성 채널 나가는 중...`);

    await cleanupCurrentStreamAndProcesses(guildId); // 스트림/프로세스 정리

    if (queue.player) {
        queue.player.stop(true); // 플레이어 완전 중지
        // player의 이벤트 리스너도 제거하는 것이 좋으나, player 객체 자체를 null로 만들면 GC 대상이 됨
    }
    if (queue.connection) {
        if (queue.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            queue.connection.destroy();
        }
    }

    if (queue.embedMessage && !queue.embedMessage.deleted) {
        try {
            // Embed 메시지를 "봇이 채널을 나갔습니다" 등으로 업데이트하거나 삭제
            const finalEmbed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('연결 종료됨')
                .setDescription('봇이 음성 채널을 나갔습니다.')
                .setFooter({ text: 'Music Bot' });
            await queue.embedMessage.edit({ embeds: [finalEmbed], components: [] }); // 버튼 비활성화/제거
        } catch (e) {
            console.warn(`[DEBUG][${guildId}] leaveChannel 중 embedMessage 수정 오류:`, e.message);
        }
    }
    // 큐 자체를 삭제하거나, 내부 상태만 초기화
    cleanupGuildQueue(guildId, true); // true: 큐 전체 삭제
    console.log(`[DEBUG][${guildId}] 채널 나가기 및 큐 정리 완료`);
}

/**
 * 큐 삭제, 내부 초기화
 * @param {*} guildId 
 * @param {*} deleteQueue 
 */
function cleanupGuildQueue(guildId, deleteQueue = false) {
    if (deleteQueue) {
        guildQueues.delete(guildId);
    } else {
        const queue = guildQueues.get(guildId);
        if (queue) {
            queue.connection = null;
            queue.player = null; // player 객체에 등록된 이벤트 리스너도 함께 정리될 수 있도록 주의
            queue.currentAudioResource = null;
            queue.currentFfmpegProcess = null;
            queue.currentYtDlpProcess = null;
            // playList, currentIndex 등은 유지하여 재접속 시 이어할 수 있도록 할 수도 있음
        }
    }
}


client.login(token);