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

// Menu Dinâmico Configurável via Painel Web
// Cada opção possui: id (número), titulo (botão do menu), resposta (texto enviado)
let menuConfig = {
  header: "🤖 *Olá! Seja bem-vindo(a) ao nosso atendimento automático.*",
  options: [
    { id: "1", titulo: "Produtos e Preços", resposta: "📦 *Nossos Produtos e Preços:*\\nTemos soluções completas para o seu negócio.\\n- Plano Starter: R$ 97/mês\\n- Plano Pro: R$ 197/mês" },
    { id: "2", titulo: "Suporte Técnico", resposta: "🛠️ *Suporte Técnico:*\\nNosso horário de atendimento é de Segunda a Sexta, das 09h às 18h." },
    { id: "3", titulo: "Falar com Atendente (Humano / IA)", resposta: "👤 *Atendimento Humano Ativado!*\\nA partir de agora você está conversando com nossa equipe." }
  ]
};

// Função para montar o texto formatado do menu com base nas opções cadastradas
function getFormattedMenu() {
  let text = `${menuConfig.header}\n\n*Escolha uma opção digitando o número correspondente:*`;
  menuConfig.options.forEach(opt => {
    text += `\n${opt.id}️⃣ - ${opt.titulo}`;
  });
  return text;
}

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
        await sock.sendMessage(remoteJid, { text: `🔄 Retornando ao menu...\n\n` + getFormattedMenu() });
        continue;
      }

      if (currentState === 'ATENDIMENTO_HUMANO') {
        continue;
      }

      if (currentState === 'MENU') {
        const matchedOption = menuConfig.options.find(opt => opt.id === cleanText);

        if (matchedOption) {
          // Se for a última opção ou se configurar explicitamente como humano (ex: ID 3 ou última)
          if (matchedOption.id === '3' || matchedOption === menuConfig.options[menuConfig.options.length - 1]) {
            userStates.set(remoteJid, 'ATENDIMENTO_HUMANO');
          }
          await sock.sendMessage(remoteJid, { text: matchedOption.resposta.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar ao menu)*" });
        } else {
          // BLOQUEIO RIGOROSO DE CONVERSA LIVRE
          await sock.sendMessage(remoteJid, { text: `⚠️ *Opção inválida!*\n\nPor favor, digite apenas o número de uma das opções válidas:\n\n` + getFormattedMenu() });
        }
      }
    }
  });
}

// Painel Web Dinâmico para Gerenciar Opções do Menu
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

  let optionsHtml = '';
  menuConfig.options.forEach((opt, index) => {
    optionsHtml += `
      <div style="background: #334155; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
        <h4>Opção ${index + 1}</h4>
        <label>Número/ID (ex: 1, 2, 4...):</label>
        <input type="text" name="id_${index}" value="${opt.id}" style="width: 100%; background: #0f172a; color: #fff; border: 1px solid #475569; padding: 8px; border-radius: 4px; margin-top: 5px;" />
        
        <label style="margin-top: 10px;">Título do Botão:</label>
        <input type="text" name="titulo_${index}" value="${opt.titulo}" style="width: 100%; background: #0f172a; color: #fff; border: 1px solid #475569; padding: 8px; border-radius: 4px; margin-top: 5px;" />

        <label style="margin-top: 10px;">Texto de Resposta:</label>
        <textarea name="resposta_${index}" style="width: 100%; height: 70px; background: #0f172a; color: #fff; border: 1px solid #475569; padding: 8px; border-radius: 4px; margin-top: 5px;">${opt.resposta}</textarea>
      </div>
    `;
  });

  res.send(`
    <html>
      <head>
        <title>Painel Dinâmico - Menu WhatsApp</title>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
          .container { max-width: 750px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
          h1 { color: #38bdf8; text-align: center; }
          .status-box { background: #334155; padding: 15px; border-radius: 8px; text-align: center; font-weight: bold; margin-bottom: 25px; }
          label { display: block; color: #cbd5e1; font-weight: bold; font-size: 0.9em; }
          button { background: #2563eb; color: white; border: none; padding: 12px 20px; font-size: 1em; font-weight: bold; border-radius: 6px; cursor: pointer; width: 100%; margin-top: 20px; }
          button:hover { background: #1d4ed8; }
          .btn-add { background: #10b981; margin-bottom: 20px; }
          .btn-add:hover { background: #059669; }
          .qr-container { text-align: center; margin-bottom: 25px; background: #334155; padding: 20px; border-radius: 8px; }
          textarea { font-family: sans-serif; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📋 Gerenciador de Menu Dinâmico</h1>
          <div class="status-box">Status: ${connectionStatus}</div>

          <div class="qr-container">
            ${qrSection}
          </div>

          <form action="/save" method="POST">
            <h3>⚙️ Cabeçalho do Menu</h3>
            <textarea name="header" style="width: 100%; height: 60px; background: #0f172a; color: #fff; border: 1px solid #475569; padding: 8px; border-radius: 4px; margin-bottom: 20px;">${menuConfig.header}</textarea>

            <h3>📑 Opções do Menu (Editar Existentes ou Adicionar Novas)</h3>
            ${optionsHtml}

            <button type="submit" class="btn-add" formaction="/add-option">➕ Adicionar Nova Opção ao Menu</button>
            <button type="submit">💾 Salvar Alterações e Atualizar Bot</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

// Salvar alterações do menu
app.post('/save', (req, res) => {
  menuConfig.header = req.body.header || menuConfig.header;
  
  let newOptions = [];
  let i = 0;
  while (req.body[`id_${i}`] !== undefined) {
    newOptions.push({
      id: req.body[`id_${i}`],
      titulo: req.body[`titulo_${i}`],
      resposta: req.body[`resposta_${i}`]
    });
    i++;
  }
  if (newOptions.length > 0) {
    menuConfig.options = newOptions;
  }
  res.redirect('/');
});

// Adicionar nova opção dinamicamente
app.post('/add-option', (req, res) => {
  menuConfig.header = req.body.header || menuConfig.header;
  
  let newOptions = [];
  let i = 0;
  while (req.body[`id_${i}`] !== undefined) {
    newOptions.push({
      id: req.body[`id_${i}`],
      titulo: req.body[`titulo_${i}`],
      resposta: req.body[`resposta_${i}`]
    });
    i++;
  }

  // Adiciona uma nova opção padrão
  const nextId = (newOptions.length + 1).toString();
  newOptions.push({
    id: nextId,
    titulo: "Novo Assunto",
    resposta: "Digite a resposta para este novo assunto aqui."
  });

  menuConfig.options = newOptions;
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  startWhatsApp();
});
