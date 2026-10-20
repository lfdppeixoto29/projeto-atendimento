const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const userStates = new Map();
let latestQR = '';
let connectionStatus = 'Aguardando inicialização...';

// Configurações personalizáveis do Bot
let botConfig = {
  menuTitle: "🤖 *Olá! Seja bem-vindo(a) ao nosso atendimento automático.*",
  opcao1Text: "📦 *Nossos Produtos e Preços:*\\nTemos soluções completas para o seu negócio.\\n- Plano Starter: R$ 97/mês\\n- Plano Pro: R$ 197/mês",
  opcao2Text: "🛠️ *Suporte Técnico:*\\nNosso horário de atendimento é de Segunda a Sexta, das 09h às 18h.",
  opcao3Text: "👤 *Atendimento Humano / Especialista Ativado!*\\nA partir de agora você está conversando com um atendente."
};

async function startWhatsApp() {
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
      connectionStatus = 'QR Code gerado! Escaneie na página de configuração.';
    }

    if (connection === 'close') {
      const shouldReconnect = (new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut);
      connectionStatus = 'Conexão fechada. Reconectando...';
      if (shouldReconnect) {
        startWhatsApp();
      }
    } else if (connection === 'open') {
      connectionStatus = 'Conectado com sucesso ao WhatsApp! 🟢';
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      if (remoteJid.endsWith('@g.us')) continue;

      const textMessage = 
        msg.message.conversation || 
        msg.message.extendedTextMessage?.text || 
        '';

      const cleanText = textMessage.trim();
      if (!cleanText) continue;

      let currentState = userStates.get(remoteJid) || 'MENU';

      if (cleanText === '#' || cleanText.toLowerCase() === '#menu') {
        userStates.set(remoteJid, 'MENU');
        const fullMenu = `${botConfig.menuTitle}\n\nEscolha uma opção:\n1️⃣ - Produtos e Preços\n2️⃣ - Suporte Técnico\n3️⃣ - Falar com Atendente`;
        await sock.sendMessage(remoteJid, { text: `🔄 Retornando...\n\n` + fullMenu });
        continue;
      }

      if (currentState === 'ATENDIMENTO_HUMANO') {
        continue;
      }

      if (currentState === 'MENU') {
        const fullMenu = `${botConfig.menuTitle}\n\nEscolha uma opção:\n1️⃣ - Produtos e Preços\n2️⃣ - Suporte Técnico\n3️⃣ - Falar com Atendente`;

        if (cleanText === '1') {
          await sock.sendMessage(remoteJid, { text: botConfig.opcao1Text.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar ao menu)*" });
        } else if (cleanText === '2') {
          await sock.sendMessage(remoteJid, { text: botConfig.opcao2Text.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar ao menu)*" });
        } else if (cleanText === '3') {
          userStates.set(remoteJid, 'ATENDIMENTO_HUMANO');
          await sock.sendMessage(remoteJid, { text: botConfig.opcao3Text.replace(/\\n/g, '\n') });
        } else {
          await sock.sendMessage(remoteJid, { text: `⚠️ *Opção inválida!*\n\nDigite apenas 1, 2 ou 3:\n\n` + fullMenu });
        }
      }
    }
  });
}

// Rota do Painel Web de Configuração e QR Code
app.get('/', async (req, res) => {
  let qrSection = '<p style="color: #fbbf24;">Gerando QR Code...</p>';

  if (latestQR && connectionStatus.includes('QR Code')) {
    try {
      const qrImage = await qrcode.toDataURL(latestQR);
      qrSection = `
        <h3>Escaneie o QR Code com seu WhatsApp:</h3>
        <img src="${qrImage}" alt="QR Code" style="background: white; padding: 10px; border-radius: 8px; width: 220px; height: 220px;" />
      `;
    } catch (e) {
      qrSection = '<p>Erro ao gerar imagem QR.</p>';
    }
  } else if (connectionStatus.includes('Conectado')) {
    qrSection = '<h3 style="color: #22c55e;">✅ WhatsApp Conectado com Sucesso!</h3>';
  }

  res.send(`
    <html>
      <head>
        <title>Painel de Controle - Bot WhatsApp</title>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
          .container { max-width: 700px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
          h1 { color: #38bdf8; text-align: center; }
          .status-box { background: #334155; padding: 15px; border-radius: 8px; text-align: center; font-weight: bold; margin-bottom: 25px; }
          label { display: block; margin-top: 15px; color: #cbd5e1; font-weight: bold; }
          textarea { width: 100%; height: 80px; background: #0f172a; color: #fff; border: 1px solid #475569; border-radius: 6px; padding: 10px; margin-top: 5px; font-family: sans-serif; }
          button { background: #2563eb; color: white; border: none; padding: 12px 20px; font-size: 1em; font-weight: bold; border-radius: 6px; cursor: pointer; width: 100%; margin-top: 25px; }
          button:hover { background: #1d4ed8; }
          .qr-container { text-align: center; margin-top: 25px; background: #334155; padding: 20px; border-radius: 8px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>⚙️ Painel de Atendimento WhatsApp</h1>
          <div class="status-box">Status: ${connectionStatus}</div>

          <div class="qr-container">
            ${qrSection}
          </div>

          <form action="/save" method="POST" style="margin-top: 30px;">
            <h3>🛠️ Customizar Mensagens do Menu</h3>
            
            <label>Título / Mensagem Inicial do Menu:</label>
            <textarea name="menuTitle">${botConfig.menuTitle}</textarea>

            <label>Resposta da Opção 1 (Produtos e Preços):</label>
            <textarea name="opcao1Text">${botConfig.opcao1Text}</textarea>

            <label>Resposta da Opção 2 (Suporte Técnico):</label>
            <textarea name="opcao2Text">${botConfig.opcao2Text}</textarea>

            <label>Resposta da Opção 3 (Falar com Atendente):</label>
            <textarea name="opcao3Text">${botConfig.opcao3Text}</textarea>

            <button type="submit">Salvar Alterações</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

// Rota para salvar configurações do painel
app.post('/save', (req, res) => {
  botConfig.menuTitle = req.body.menuTitle || botConfig.menuTitle;
  botConfig.opcao1Text = req.body.opcao1Text || botConfig.opcao1Text;
  botConfig.opcao2Text = req.body.opcao2Text || botConfig.opcao2Text;
  botConfig.opcao3Text = req.body.opcao3Text || botConfig.opcao3Text;
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  startWhatsApp();
});
