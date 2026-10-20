const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Armazenamento em memória dos estados dos clientes
const userStates = new Map();

// Variável para armazenar o último QR Code gerado em texto/data-url
let latestQR = '';
let connectionStatus = 'Aguardando inicialização...';

const MENU_TEXT = 
`🤖 *Olá! Seja bem-vindo(a) ao nosso atendimento automático.*

Para continuarmos, por favor escolha uma das opções abaixo digitando apenas o número correspondente:

1️⃣ - Falar sobre Produtos e Preços
2️⃣ - Suporte Técnico / Dúvidas
3️⃣ - Falar com Atendente (Humano / IA Livre)`;

const OPCAO_1_TEXT = 
`📦 *Nossos Produtos e Preços:*
Temos soluções completas para o seu negócio.
- Plano Starter: R$ 97/mês
- Plano Pro: R$ 197/mês

Digite *#* a qualquer momento para voltar ao menu principal.`;

const OPCAO_2_TEXT = 
`🛠️ *Suporte Técnico:*
Nosso horário de atendimento é de Segunda a Sexta, das 09h às 18h.
Envie sua dúvida detalhada ou aguarde nosso contato.

Digite *#* a qualquer momento para voltar ao menu principal.`;

const OPCAO_3_TEXT = 
`👤 *Atendimento Humano / Especialista Ativado!*
A partir de agora você está conectado com nosso atendente. Pode enviar sua mensagem livremente.

*(Para retornar ao menu automático, digite #menu)*`;

// Função para iniciar o WhatsApp com Baileys e Sessão Persistente no Railway
async function startWhatsApp() {
  // Usamos uma pasta persistente ou local para auth_info
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = 'QR Code gerado! Escaneie na página principal.';
      console.log('[QR CODE GERADO] Acesse a raiz do seu site para escanear.');
      // Também imprime no terminal/logs do Railway em ASCII
      qrcode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
        if (!err) console.log(url);
      });
    }

    if (connection === 'close') {
      const shouldReconnect = (new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut);
      connectionStatus = 'Conexão fechada. Tentando reconectar...';
      console.log('[CONEXÃO] Fechada devido a:', lastDisconnect?.error, 'Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        startWhatsApp();
      }
    } else if (connection === 'open') {
      connectionStatus = 'Conectado com sucesso ao WhatsApp! 🟢';
      console.log('[CONEXÃO] WhatsApp conectado com sucesso!');
    }
  });

  // Listener de mensagens recebidas com Menu Estrito
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      // Ignorar grupos
      if (remoteJid.endsWith('@g.us')) continue;

      const textMessage = 
        msg.message.conversation || 
        msg.message.extendedTextMessage?.text || 
        '';

      const cleanText = textMessage.trim();
      if (!cleanText) continue;

      console.log(`[MENSAGEM RECEBIDA] De ${remoteJid}: "${cleanText}"`);

      let currentState = userStates.get(remoteJid) || 'MENU';

      // Comando universal para voltar ao menu
      if (cleanText === '#' || cleanText.toLowerCase() === '#menu') {
        userStates.set(remoteJid, 'MENU');
        await sock.sendMessage(remoteJid, { text: `🔄 Retornando ao menu principal...\n\n` + MENU_TEXT });
        continue;
      }

      // Se o cliente escolheu a opção 3 (Atendimento Humano / Conversa Livre)
      if (currentState === 'ATENDIMENTO_HUMANO') {
        console.log(`[ATENDIMENTO LIVRE] Cliente ${remoteJid} em atendimento humano.`);
        continue;
      }

      // Estado MENU (Menu Estrito)
      if (currentState === 'MENU') {
        if (cleanText === '1') {
          await sock.sendMessage(remoteJid, { text: OPCAO_1_TEXT });
        } else if (cleanText === '2') {
          await sock.sendMessage(remoteJid, { text: OPCAO_2_TEXT });
        } else if (cleanText === '3') {
          userStates.set(remoteJid, 'ATENDIMENTO_HUMANO');
          await sock.sendMessage(remoteJid, { text: OPCAO_3_TEXT });
        } else {
          // Bloqueio rigoroso de conversa livre
          const bloqueioMsg = `⚠️ *Opção inválida!*\n\nPor favor, digite apenas o número correspondente à opção desejada (1, 2 ou 3):\n\n` + MENU_TEXT;
          await sock.sendMessage(remoteJid, { text: bloqueioMsg });
        }
      }
    }
  });
}

// Rota web para exibir o status e o QR Code visualmente na tela
app.get('/', async (req, res) => {
  let qrHtml = '<p>Carregando QR Code ou WhatsApp já conectado...</p>';
  
  if (latestQR && connectionStatus.includes('QR Code')) {
    try {
      const qrImage = await qrcode.toDataURL(latestQR);
      qrHtml = `
        <h3>Escaneie o QR Code abaixo com o seu WhatsApp:</h3>
        <img src="${qrImage}" alt="QR Code WhatsApp" style="border: 10px solid white; border-radius: 8px; margin-top: 15px; width: 260px; height: 260px;" />
        <p style="margin-top: 15px; color: #38bdf8;">Abra o WhatsApp no celular > Aparelhos Conectados > Conectar um Aparelho</p>
      `;
    } catch (e) {
      qrHtml = '<p>Erro ao gerar imagem do QR Code.</p>';
    }
  } else if (connectionStatus.includes('Conectado')) {
    qrHtml = '<h2 style="color: #22c55e;">✅ WhatsApp Conectado com Sucesso! O bot está ativo.</h2>';
  }

  res.send(`
    <html>
      <head>
        <title>Atendimento WhatsApp - QR Code</title>
        <meta charset="utf-8">
        <meta http-equiv="refresh" content="5">
        <style>
          body { font-family: Arial, sans-serif; background: #0f172a; color: #fff; text-align: center; padding-top: 40px; }
          .card { background: #1e293b; max-width: 550px; margin: 0 auto; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
          h1 { color: #38bdf8; margin-bottom: 5px; }
          .status { font-weight: bold; font-size: 1.1em; margin: 15px 0; color: #fbbf24; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🤖 Robô WhatsApp (Menu Estrito)</h1>
          <div class="status">Status: ${connectionStatus}</div>
          <div style="margin-top: 20px;">
            ${qrHtml}
          </div>
        </div>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  startWhatsApp();
});
