require('dotenv').config();

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, getVoiceConnection, entersState, VoiceConnectionStatus, StreamType  } = require('@discordjs/voice');
//const ytdl = require('ytdl-core');  //수정예정

//const  ytdl = require("ytdl-core");  //추가 재생안되는바람에 수정
//const  fs  =  require ( 'fs' ) ;  //추가 재생안되는바람에 수정
//const play_dl = require('play-dl');

const { token, youtubeApiKey, ffmpegPath } = require('./discordConfig.js');

const token = process.env.DISCORD_TOKEN;
const youtubeApiKey = process.env.YOUTUBE_API_KEY;
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ytDlpPath = process.env.YT_DLP_PATH || 'yt-dlp';


//const ffmpeg = require('fluent-ffmpeg');
//ffmpeg.setFfmpegPath(ffmpegPath);

const sodium = require('libsodium-wrappers'); // 추가된 부분
const search = require('youtube-search'); // 유튜브 검색 추가

// ytdl 사용 x
// 직접 ffmpeg와 yt-dlp 로 pc에서 노래 다운 이후 인코딩 및 실행 (25.05.06)
const { spawn } = require('child_process');


const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

const opts = {
  maxResults: 1,
  key: youtubeApiKey,
  type: 'video'
};

// 준비
client.on('ready', () => console.log(`${client.user.tag} 에 로그인됨`));

// 봇 명령어 구분 문자 
const prefix = '!'; 

let connection;
let voiceChannel;
let player;
let playList = [];
let playListTitle = [];
let playListThumbnail = [];

let ytStream;
let ffmpeg;

let isPlaying = false;
let playRepeat = false;
let currentIndex  = 0;
let embedMessage = null; // 처음 전송된 embed 메시지를 저장할 변수
let isSkip = false;

let resource;

//명령어가 !재생인경우
function prefixPlay(message){
  const query = message.content.replace('!재생', '').trim();

  let playUrl = "";
  let title;
  let thumbnailUrl;

  if (!query) {
    return message.reply('재생할 노래 제목이나 URL을 입력하세요.');
  }

  voiceChannel = message.member.voice.channel;
  if (!voiceChannel) {
    return message.reply('채널에 먼저 선 입장 필요');
  }
  
  const permissions = voiceChannel.permissionsFor(message.client.user);
  if (!permissions.has('CONNECT') || !permissions.has('SPEAK')) {
    return message.reply('권한이 없습니다.');
  }

  if (query.indexOf('https://www.youtube.com') != -1) {

    playUrl = query;
    title = query;
    thumbnailUrl = '';
    playList.push(playUrl);
    playListTitle.push(title);
    playListThumbnail.push(thumbnailUrl);
            
    if (!isPlaying) {
      playNext(voiceChannel, message, title, thumbnailUrl);
    } else {
      
      message.reply(`"${playUrl}"이(가) 재생 목록에 추가됨`);  
    }
  } else {
    search(query, opts, async (err, results) => {
      if (err) return console.error(err);
  
      if (results.length === 0) {
        return message.reply('검색 결과가 없습니다.');
      }
  
      playUrl = results[0].link;
      title = results[0].title;
      thumbnailUrl = results[0].thumbnails.default.url;
      playList.push(playUrl);
      playListTitle.push(title);
      playListThumbnail.push(thumbnailUrl);
              
      if (!isPlaying) {
        playNext(voiceChannel, message, title, thumbnailUrl);
      } else {
        
        if (embedMessage && (playList.length % 5 === 0)) {
          await embedMessage.delete();
          sendEmbedMessage(message, title, thumbnailUrl);
        }
        message.reply(`"${title}"이(가) 재생 목록에 추가됨`);  
      }
  
    });
  }
}


// 리소스 삭제
async function stopStream() {
  // playStream 종료
  if (resource?.playStream && !resource.playStream.destroyed) {
    try {
      resource.playStream.push(null);  // 더 이상 데이터 전송하지 않겠다고 알림
      await new Promise((resolve) => {
        resource.playStream.once('end', resolve); // end 이벤트 기다리기

        // 타임아웃 대기 (예: 3초 뒤 강제 종료)
        setTimeout(() => {
          if (!resource.playStream.destroyed) {
            resource.playStream.destroy();
            resolve(); // 타임아웃 시 강제 종료
          }
        }, 3000);
      });
    } catch (err) {
      console.warn("playStream 처리 중 오류:", err.message);
    }
  }

  // ffmpeg 종료
  if (ffmpeg?.stdin && !ffmpeg.stdin.destroyed) {
    try {
      ffmpeg.stdin.end();  // stdin 종료
      ffmpeg.kill('SIGKILL');  // ffmpeg 강제 종료
    } catch (err) {
      console.warn("ffmpeg 종료 중 오류:", err.message);
    }
  }

  // ytStream 종료
  if (ytStream) {
    ytStream.stdout?.destroy();  // 스트림 종료
    ytStream.kill('SIGKILL');  // 강제 종료
    ytStream = null;
  }

  resource = null;  // resource 초기화
  ffmpeg = null;  // ffmpeg 초기화
}

// stdin 기다리려고했는데 의미없음
async function waitForWritableStdin() {
  console.log("넘기기3");
  return new Promise((resolve, reject) => {
    console.log("기다림111");
    /*
    if (!ffmpeg || !ffmpeg.stdin) {
      console.warn("ffmpeg 또는 ffmpeg.stdin이 없습니다.");
      return resolve(false); // 또는 reject(new Error("ffmpeg 없음"))
    }
    const checkInterval = setInterval(() => {
      console.log("기다림222");
      if (
        ffmpeg?.stdin &&
        !ffmpeg.stdin.destroyed &&
        !ffmpeg.stdin.writableEnded &&
        ffmpeg.stdin.writable
      ) {
        console.log("기다림");
        clearInterval(checkInterval); // 조건이 만족되면 종료
        resolve(true);  // 기다림 완료
      }
    }, 100); // 100ms마다 확인
    */
  });
}

// stdin 기다리려고했는데 의미없음
async function stopPlayer() {
  try {
    const ready = await waitForWritableStdin();
    return;
    if (!ready) {
      console.warn("ffmpeg stdin이 쓰기 불가능한 상태입니다.");
    }

    console.log("넘기기4");

    if (player) {
      console.log("넘기기5");
      player.stop();
      console.log("플레이어 중지");
      

      if (
        ffmpeg?.stdin &&
        !ffmpeg.stdin.destroyed &&
        !ffmpeg.stdin.writableEnded &&
        ffmpeg.stdin.writable
      ) {
        console.log("ffmpeg.stdin이 여전히 쓰기 가능함");
        // ffmpeg.stdin.write() 등의 작업 수행
      } else {
        console.warn("ffmpeg.stdin이 종료되었거나 쓰기 불가능함");
      }
  
      // 3. yt-dlp 종료 처리
      if (ytStream) {
        console.log("ytStream 종료 처리");
        ytStream.kill('SIGKILL'); // yt-dlp 종료
        ytStream = null;
      }
  
      // 4. ffmpeg 종료
      if (ffmpeg) {
        console.log("ffmpeg 종료 중...");
        // ffmpeg.stdin 종료 후, ffmpeg.kill() 호출
        if (ffmpeg.stdin) {
          ffmpeg.stdin.end();  // 입력 종료
          ffmpeg.stdin.once('close', () => {
            // ffmpeg가 종료된 후 후속 작업 처리
            ffmpeg.kill('SIGKILL');
          });
        } else {
          // stdin이 없을 경우 바로 종료 처리
          ffmpeg.kill('SIGKILL');
        }
        ffmpeg = null;
      }
    }
  } catch (error) {
    console.error("오류 발생:", error);
  }
}


function safeWrite(stream, chunk) {

  console.warn("상태확인시작===================");
  if (!stream) {
    console.warn("safeWrite skipped: stream is null");
    return false;
  }

  if (stream.destroyed) {
    console.warn("safeWrite skipped: stream is destroyed");
    return false;
  }

  if (stream.writableEnded) {
    console.warn("safeWrite skipped: stream writableEnded");
    return false;
  }

  if (!stream.writable) {
    console.warn("safeWrite skipped: stream not writable");
    return false;
  }

  if (isSkip) {
    console.warn("safeWrite skipped: isSkip is true");
    return false;
  }

  console.warn("상태확인끝===================");

  if (
    stream &&
    !stream.destroyed &&
    !stream.writableEnded &&
    stream.writable &&
    !isSkip&&
    chunk!=null
  ) {
    try {
      console.log(chunk);
      //return stream.write(chunk);
      return stream.write(chunk, (err) => {
        if (err) {
          console.warn("safeWrite callback error:", err.message);
        }
      });
    } catch (e) {
      console.warn('safeWrite error:', e.message);
      return false;
    }
  }
  console.warn('safeWrite skipped: stream not writable');
  return false;
}


async function playNext(voiceChannel, message) {

  if (playList.length === 0) {
    isPlaying = false;
    updateEmbedMessage('재생중인 노래가 없습니다', '', '', 'Music Bot (반복재생 off)');
    return;
  }

  if(currentIndex >= playList.length){
    
    if(playRepeat){
      currentIndex=0;
    }else{
      isPlaying = false;
      updateEmbedMessage('재생중인 노래가 없습니다', '', '', 'Music Bot (반복재생 off)');
      return;
    }
  }

  isPlaying = true;
  isSkip = false;
  const playUrl = playList[currentIndex]; // 재생목록의 현재인덱스로 재생
  
  let canWrite;
  try {
    
    if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });

      try {
        // connection이 ready 상태일 때까지 최대 30초 기다림
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        console.log("✅ Voice connection ready");
      } catch (err) {
        console.error("❌ Voice connection failed:", err);
        return;
      }
    }
    

    /*
    ytStream = spawn(ytDlpPath, [
      '-f', 'bestaudio',
      '-o', '-',
      playUrl
    ]);
    */

    ytStream = spawn('yt-dlp', ['-f', 'bestaudio', '--no-playlist', playUrl, '-o', '-'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1'
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    ffmpeg.stderr.on('data', (data) => {
      console.error(`[${playUrl}] FFMPEG STDERR: ${data.toString()}`);
      
    });
    ytStream.stderr.on('data', (data) => { // yt-dlp의 stderr 로깅
        console.error(`[${playUrl}] YT-DLP STDERR: ${data.toString()}`);
    });

    console.log("시작")
    ytStream.stdout.on('data', (chunk) => {
      console.log("Chunk isBuffer:", Buffer.isBuffer(chunk)); // ✅ true 여야 정상
      console.log("Chunk type:", typeof chunk, chunk?.constructor?.name); // ✅ Buffer

      if (!ffmpeg?.stdin?.writable || ffmpeg.stdin.destroyed) {
        console.warn("⚠️ ffmpeg.stdin이 닫혀 있음. write 생략");
        return;
      }
    
      console.log(chunk);
      const canWrite = ffmpeg.stdin.write(chunk);
    
      if (!canWrite) {
        ytStream.stdout.pause();
        ffmpeg.stdin.once("drain", () => {
          ytStream.stdout.resume();
        });
      }
    });
    
    ytStream.stdout.on('end', () => {
      if (!ffmpeg.stdin.destroyed) {
        ffmpeg.stdin.end();
      }
    });

    
    ytStream.on('close', () => {
      try {
        ffmpeg.stdin.end();
      } catch (e) {
        console.warn('ffmpeg.stdin end error:', e.message);
      }
    });
  
    ffmpeg.on('close', (code) => {
      console.log(`ffmpeg closed with code ${code}`);
    });

    ytStream.on('exit', (code, signal) => {
      console.log(`yt-dlp exited with code ${code}, signal ${signal}`);
    });
    
    ffmpeg.on('exit', (code, signal) => {
      console.log(`ffmpeg exited with code ${code}, signal ${signal}`);
    });

    resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw
    });
   
    if (!player) {
      player = createAudioPlayer();
      
      //현재 플레이되는 곡의 재생 종료 이벤트를 받는 구간
      player.on(AudioPlayerStatus.Idle, () => {
        
        console.log("🔁 AudioPlayer 상태가 Idle로 전환됨 — 정리 실행");
        currentIndex++;  //인덱스 증가하여 다음 재생목록 실행
        playNext(voiceChannel, message);
      });
      
      connection.subscribe(player);
    }

    
    player.play(resource);
    
    // 처음에만 embed 메시지를 전송
    if (!embedMessage) {
      sendEmbedMessage(message, playListTitle[currentIndex], playListThumbnail[currentIndex]);
    } else {
      updateEmbedMessage('현재 재생 중', playListTitle[currentIndex], playListThumbnail[currentIndex], 'Music Bot (반복재생 off)');
    }
    
  } catch (error) {
    console.error(error);
  }
}

// 처음 embed 메시지 전송
function sendEmbedMessage(message, title, thumbnailUrl) {

  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('현재 재생 중')
    .setDescription(`**${title}**`)
    .setThumbnail(thumbnailUrl)
    .setFooter({ text: 'Music Bot' });

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('skip')
        .setLabel('넘기기')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('songList')
        .setLabel('재생목록')
        .setStyle(ButtonStyle.Primary),  
      new ButtonBuilder()
        .setCustomId('stop')
        .setLabel('컷')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('loop')
        .setLabel('반복 재생')
        .setStyle(ButtonStyle.Primary)
    );

  message.reply({ embeds: [embed], components: [row] }).then(sentMessage => {
    embedMessage = sentMessage; // 전송된 메시지를 저장
  });
}

// embed 메시지 업데이트
function updateEmbedMessage(title, songTitle, thumbnailUrl, footer) {
  if (!embedMessage) return;

  const updatedEmbed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle(title)
    .setDescription(`**${songTitle}**`)
    .setFooter({ text: footer });

  if (thumbnailUrl) {
    updatedEmbed.setThumbnail(thumbnailUrl);
  }

  embedMessage.edit({ embeds: [updatedEmbed] });
}

// 버튼 클릭 처리
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;

  if (customId === 'skip') {
    await interaction.reply({ content: '노래를 스킵합니다!', ephemeral: true });
    
    if (stopStreams() && player) {
      isSkip = true;
      stopPlayer();
    }
  } else if (customId === 'songList') {

    if (playList.length === 0) {
      return interaction.reply('재생 목록 없음');
    }

    let response = '재생 목록:\n';
    playListTitle.forEach((item, index) => {
      response += `[${index}] = ${item}\n`;
    });
    interaction.reply(response);

  } else if (customId === 'stop') {

    await interaction.reply({ content: '노래봇이 꺼졌습니다'});
    if (embedMessage) {
      await embedMessage.delete();
      embedMessage = null; // 삭제 후 참조를 초기화
    }
    isPlaying = false;
    if (stopStreams() && player) {
      isSkip = true;
      stopPlayer();
    }
    
    if (connection) {   
        leaveChannel()
    }

  } else if (customId === 'loop') {

    await interaction.deferUpdate();
    if(!playRepeat){
      playRepeat = true;
      
      updateEmbedMessage('현재 재생 중', playListTitle[currentIndex], playListThumbnail[currentIndex], 'Music Bot (반복재생 on)');
    } 
    else if(playRepeat){
      playRepeat = false;
      
      updateEmbedMessage('현재 재생 중', playListTitle[currentIndex], playListThumbnail[currentIndex], 'Music Bot (반복재생 off)');
    }
    
  }
});

// 채널 나가기
function leaveChannel(){
  
  connection.destroy()
  connection = "" // connection 을 null로 만들어야지 다음 join이 됨...
  //채널 나갈시 모두 초기화 시킴
  player = ""
  playList = [];
  playListTitle = [];
  playListThumbnail = [];
  isPlaying = false;
  playRepeat = false;
  currentIndex  = 0; 
}

function stopCurrentStream() {
  try {
    if (ytStream?.stdout?.pause) {
      ytStream.stdout.pause(); // 백프레셔 발생 중이면 바로 멈추기
    }

    if (ffmpeg?.stdin?.writable) {
      ffmpeg.stdin.end(); // 더 이상 write하지 않도록 종료
    }

    // yt-dlp 강제 종료
    if (ytStream && !ytStream.killed) {
      ytStream.kill('SIGKILL');
    }

    // ffmpeg 강제 종료
    if (ffmpeg && !ffmpeg.killed) {
      ffmpeg.kill('SIGKILL');
    }

    ytStream = null;
    ffmpeg = null;
  } catch (err) {
    console.error('stopCurrentStream 중 에러:', err.message);
  }
}

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    if (!message.content.startsWith(prefix)) return;

    if (message.content === '!재생목록'){

      if (playList.length === 0) {
        return message.reply('재생 목록 없음');
      }
  
      let response = '현재 재생 목록:\n';
      playListTitle.forEach((item, index) => {
        response += `[${index}] = ${item}\n`;
      });
      message.reply(response);
    }
    else if (message.content.startsWith('!삭제')) {
      const index = parseInt(message.content.replace('!삭제', '').trim(), 10);
      if (isNaN(index) || index < 0 || index >= playList.length) {
        return message.reply('잘못된 인덱스');
      }
  
      let removed = playList.splice(index, 1);
      removed = playListTitle.splice(index, 1);
      playListThumbnail.splice(index, 1);
      
      if (index === currentIndex && index === playList.length) {
        currentIndex = 0;
      } else if (index <= currentIndex) {
        currentIndex--;
      }

      message.reply(`"${removed[0]}" 재생 목록에서 삭제`); 
    }
    else if(message.content === '!넘기기'){
      if (player) {
        isSkip = true;
        await stopCurrentStream();  // 스트림 안전 종료
        player.stop();
      }
        
    }
    else if (message.content.startsWith("!재생")) prefixPlay(message);
    else if (message.content === '!반복재생'){
      if(!playRepeat){
        playRepeat = true;
        message.reply('반복재생 켜짐');
      } 
      else if(playRepeat){
        playRepeat = false;
        message.reply('반복재생 꺼짐');
      } 
    }
    else if(message.content === '!초기화'){
      playList = [];
      playListTitle = [];
      message.reply('재생목록 초기화');
    }
    else if(message.content === '!컷' || message.content === '!중지'){
      isPlaying = false;
      if (stopStreams() && player) {
        isSkip = true;
        stopPlayer();
        if (connection) leaveChannel()
      }
    }
    
  });
  
  client.login(token);