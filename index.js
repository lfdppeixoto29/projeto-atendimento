const express = require('express');
const fetch = require('node-fetch');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Instância única do WhatsApp (direto via Baileys)
let sock = null;
let whatsappStatus = 'Iniciando conexão...';

// Armazenamento de estados dos clientes
const userStates = new Map();

// Configurações
const config = {
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  aiPrompt: "Você é um assistente virtual prestativo e educado. Responda de forma clara e objetiva.",

  empresaHeader: "🏢 *Atendimento Corporativo (Empresa)*",
  solicitarDadosMsg: "Para iniciarmos o atendimento da sua empresa, por favor informe:\n1️⃣ *Nome da Empresa*\n2️⃣ *CNPJ*\n\n*(Responda enviando os dados em uma única mensagem)*",
  sucessoDadosMsg: "✅ *Dados cadastrados com sucesso!*",

  menuEmpresaHeader: "📋 *Menu da Empresa - Escolha uma opção:*",
  item1: "1️⃣ - Comercial / Orçamentos",
  resp1: "📦 *Comercial:* Nossos consultores vão analisar sua solicitação.",
  item2: "2️⃣ - Suporte Técnico",
  resp2: "🛠️ *Suporte Técnico:* Descreva o problema enfrentado.",
  item3: "3️⃣ - Financeiro",
  resp3: "💰 *Financeiro:* Envie sua solicitação de faturamento.",

  falhaMsg: "❌ *Opção inválida!* Digite obrigatoriamente 1, 2 ou 3 para prosseguir.",
  configTrigger: "#config",
  configResp: "⚙️ *Painel Administrativo da Empresa Ativo.*",
  particularIntro: "🤖 *Atendimento Particular ativado!* A partir de agora nossa Inteligência Artificial vai conversar com você."
};

async function askAI(userMessage) {
  if (!config.openaiApiKey) return "⚠️ Chave da API OpenAI não configurada no servidor.";
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openaiApiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: config.aiPrompt },
          { role: "user", content: userMessage }
        ],
        temperature: 0.7
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Desculpe, não consegui processar sua resposta no momento.";
  } catch (err) {
    console.error('[ERRO IA]:', err);
    return "Desculpe, ocorreu um erro ao consultar a inteligência artificial.";
  }
}

async function handleIncomingMessage(remoteJid, textMessage) {
  const cleanText = textMessage.trim();
  if (!cleanText) return;

  let session = userStates.get(remoteJid) || { mode: 'INICIAL' };

  // Comando universal para voltar ao menu
  if (cleanText === '#' || cleanText.toLowerCase() === '#menu') {
    userStates.set(remoteJid, { mode: 'INICIAL' });
    const menuInicial = 
      `🤖 *Olá! Seja bem-vindo(a).*\n\nComo deseja ser atendido?\n\n` +
      `1️⃣ - Empresa (Exige dados e menu obrigatório)\n` +
      `2️⃣ - Particular (Atendimento livre com IA)`;
    await sock.sendMessage(remoteJid, { text: menuInicial });
    return;
  }

  // 1. Modo PARTICULAR -> Conversa livre com IA
  if (session.mode === 'PARTICULAR') {
    const aiResponse = await askAI(cleanText);
    await sock.sendMessage(remoteJid, { text: aiResponse });
    return;
  }

  // 2. Modo COLETANDO_DADOS (Empresa)
  if (session.mode === 'COLETANDO_DADOS') {
    session.dadosEmpresa = cleanText;
    session.mode = 'EMPRESA_MENU';
    userStates.set(remoteJid, session);

    const menuEmpresa = 
      `${config.sucessoDadosMsg}\n\n${config.menuEmpresaHeader}\n` +
      `${config.item1}\n${config.item2}\n${config.item3}\n\n` +
      `*(Digite o número da opção desejada ou # para voltar)*`;
    
    await sock.sendMessage(remoteJid, { text: menuEmpresa });
    return;
  }

  // 3. Modo EMPRESA_MENU
  if (session.mode === 'EMPRESA_MENU') {
    if (cleanText.toLowerCase() === config.configTrigger.toLowerCase()) {
      await sock.sendMessage(remoteJid, { text: config.configResp + "\n\n*(Digite # para voltar)*" });
      return;
    }

    if (cleanText === '1') {
      await sock.sendMessage(remoteJid, { text: config.resp1.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*" });
    } else if (cleanText === '2') {
      await sock.sendMessage(remoteJid, { text: config.resp2.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*" });
    } else if (cleanText === '3') {
      await sock.sendMessage(remoteJid, { text: config.resp3.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*" });
    } else {
      const menuEmpresa = 
        `${config.menuEmpresaHeader}\n` +
        `${config.item1}\n${config.item2}\n${config.item3}\n\n` +
        `⚠️ *(Digite # para voltar ao início)*`;

      await sock.sendMessage(remoteJid, { text: `${config.falhaMsg}\n\n` + menuEmpresa });
    }
    return;
  }

  // 4. Modo INICIAL
  if (session.mode === 'INICIAL') {
    if (cleanText === '1') {
      session.mode = 'COLETANDO_DADOS';
      userStates.set(remoteJid, session);
      await sock.sendMessage(remoteJid, { text: `${config.empresaHeader}\n\n${config.solicitarDadosMsg}` });
    } 
    else if (cleanText === '2') {
      session.mode = 'PARTICULAR';
      userStates.set(remoteJid, session);
      await sock.sendMessage(remoteJid, { text: config.particularIntro });
    } 
    else {
      const menuInicial = 
        `❌ *Opção inválida!*\n\nEscolha como deseja ser atendido:\n\n` +
        `1️⃣ - Empresa (Exige dados e menu obrigatório)\n` +
        `2️⃣ - Particular (Atendimento livre com IA)`;
      await sock.sendMessage(remoteJid, { text: menuInicial });
    }
  }
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'close') {
      const shouldReconnect = (new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut);
      whatsappStatus = 'Conexão fechada. Reconectando...';
      console.log('[CONEXÃO] Fechada. Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        startWhatsApp();
      } else {
        whatsappStatus = 'Deslogado. É necessário um novo pareamento.';
      }
    } else if (connection === 'open') {
      whatsappStatus = 'Conectado com sucesso ao WhatsApp! 🟢';
      console.log('[CONEXÃO] WhatsApp conectado com sucesso!');
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

      if (!textMessage) continue;

      console.log(`[MENSAGEM RECEBIDA] De ${remoteJid}: "${textMessage}"`);
      await handleIncomingMessage(remoteJid, textMessage);
    }
  });
}

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta http-equiv="refresh" content="5">
        <title>Atendimento WhatsApp - Status</title>
        <style>
          body { font-family: sans-serif; background: #0f172a; color: #fff; text-align: center; padding-top: 80px; }
          .box { background: #1e293b; display: inline-block; padding: 30px 60px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
          h1 { color: #38bdf8; font-size: 1.4em; }
          p { color: ${whatsappStatus.includes('Conectado') ? '#22c55e' : '#fbbf24'}; font-weight: bold; font-size: 1.1em; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>🤖 Atendimento WhatsApp Online</h1>
          <p>${whatsappStatus}</p>
        </div>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  startWhatsApp();
});
