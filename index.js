const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const instances = new Map();
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function getDefaultConfig() {
  return {
    name: "Nova Instância",
    // Configuração de IA para a opção Particular
    openaiApiKey: "",
    aiPrompt: "Você é um assistente virtual prestativo e educado. Responda de forma clara e objetiva.",

    // Empresa - Coleta de Dados Obrigatória
    empresaHeader: "🏢 *Atendimento Corporativo (Empresa)*",
    solicitarDadosMsg: "Para iniciarmos o atendimento da sua empresa, por favor informe:\n1️⃣ *Nome da Empresa*\n2️⃣ *CNPJ*\n\n*(Responda enviando os dados em uma única mensagem)*",
    sucessoDadosMsg: "✅ *Dados cadastrados com sucesso!*",

    // Menu Empresa (Itens 1 ao 3 obrigatórios)
    menuEmpresaHeader: "📋 *Menu da Empresa - Escolha uma opção:*",
    item1: "1️⃣ - Comercial / Orçamentos",
    resp1: "📦 *Comercial:* Nossos consultores vão analisar sua solicitação.",
    item2: "2️⃣ - Suporte Técnico",
    resp2: "🛠️ *Suporte Técnico:* Descreva o problema enfrentado.",
    item3: "3️⃣ - Financeiro",
    resp3: "💰 *Financeiro:* Envie sua solicitação de faturamento.",

    // Falha e Config
    falhaMsg: "❌ *Opção inválida!* Digite obrigatoriamente 1, 2 ou 3 para prosseguir.",
    configTrigger: "#config",
    configResp: "⚙️ *Painel Administrativo da Empresa Ativo.*",

    // Particular com IA
    particularIntro: "🤖 *Atendimento Particular ativado!* A partir de agora nossa Inteligência Artificial vai conversar com você."
  };
}

function createInstance(instanceId) {
  if (instances.has(instanceId)) return instances.get(instanceId);

  const sessionPath = path.join(SESSIONS_DIR, instanceId);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const instanceData = {
    id: instanceId,
    sock: null,
    qr: '',
    status: 'Iniciando...',
    config: getDefaultConfig(),
    userStates: new Map() // Jid -> { mode: 'INICIAL' | 'COLETANDO_DADOS' | 'EMPRESA_MENU' | 'PARTICULAR', dadosEmpresa: null }
  };

  instances.set(instanceId, instanceData);
  startWhatsAppInstance(instanceData, sessionPath);
  return instanceData;
}

// Função para chamar a IA (OpenAI GPT)
async function askAI(apiKey, prompt, userMessage) {
  if (!apiKey) return "⚠️ Chave da API OpenAI não configurada no painel.";
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: prompt },
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

async function startWhatsAppInstance(inst, sessionPath) {
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });

  inst.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      inst.qr = qr;
      inst.status = 'QR Code gerado! Escaneie na tela.';
    }
    if (connection === 'close') {
      const shouldReconnect = (new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut);
      inst.status = 'Conexão fechada. Reconectando...';
      if (shouldReconnect) startWhatsAppInstance(inst, sessionPath);
    } else if (connection === 'open') {
      inst.status = 'Conectado com sucesso ao WhatsApp! 🟢';
      inst.qr = '';
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      if (remoteJid.endsWith('@g.us')) continue;

      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const cleanText = textMessage.trim();
      if (!cleanText) continue;

      let session = inst.userStates.get(remoteJid) || { mode: 'INICIAL' };

      // Comando universal de retorno ao menu inicial
      if (cleanText === '#' || cleanText.toLowerCase() === '#menu') {
        inst.userStates.set(remoteJid, { mode: 'INICIAL' });
        const menuInicial = 
          `🤖 *Olá! Seja bem-vindo(a).*\n\nComo deseja ser atendido?\n\n` +
          `1️⃣ - Empresa (Exige dados e menu obrigatório)\n` +
          `2️⃣ - Particular (Atendimento livre com IA)`;
        await sock.sendMessage(remoteJid, { text: `🔄 Retornando ao menu principal...\n\n` + menuInicial });
        continue;
      }

      // 1. Modo PARTICULAR -> Conversa livre com IA
      if (session.mode === 'PARTICULAR') {
        const aiResponse = await askAI(inst.config.openaiApiKey, inst.config.aiPrompt, cleanText);
        await sock.sendMessage(remoteJid, { text: aiResponse });
        continue;
      }

      // 2. Modo COLETANDO_DADOS (Empresa) -> Obrigatório informar dados antes de entrar no menu
      if (session.mode === 'COLETANDO_DADOS') {
        session.dadosEmpresa = cleanText;
        session.mode = 'EMPRESA_MENU';
        inst.userStates.set(remoteJid, session);

        const menuEmpresa = 
          `${inst.config.sucessoDadosMsg}\n\n${inst.config.menuEmpresaHeader}\n` +
          `${inst.config.item1}\n${inst.config.item2}\n${inst.config.item3}\n\n` +
          `*(Digite o número da opção desejada ou # para voltar)*`;
        
        await sock.sendMessage(remoteJid, { text: menuEmpresa });
        continue;
      }

      // 3. Modo EMPRESA_MENU -> Menu estrito com itens 1 a 3 obrigatórios + Falha + Config
      if (session.mode === 'EMPRESA_MENU') {
        if (cleanText.toLowerCase() === inst.config.configTrigger.toLowerCase()) {
          await sock.sendMessage(remoteJid, { text: inst.config.configResp + "\n\n*(Digite # para voltar)*" });
          continue;
        }

        if (cleanText === '1') {
          await sock.sendMessage(remoteJid, { text: inst.config.resp1.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*" });
        } else if (cleanText === '2') {
          await sock.sendMessage(remoteJid, { text: inst.config.resp2.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*" });
        } else if (cleanText === '3') {
          await sock.sendMessage(remoteJid, { text: inst.config.resp3.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*" });
        } else {
          // OPÇÃO DE FALHA (Fallback)
          const menuEmpresa = 
            `${inst.config.menuEmpresaHeader}\n` +
            `${inst.config.item1}\n${inst.config.item2}\n${inst.config.item3}\n\n` +
            `⚠️ *(Digite # para voltar ao início)*`;

          await sock.sendMessage(remoteJid, { text: `${inst.config.falhaMsg}\n\n` + menuEmpresa });
        }
        continue;
      }

      // 4. Modo INICIAL (Escolha Empresa vs. Particular)
      if (session.mode === 'INICIAL') {
        if (cleanText === '1') {
          // Escolheu Empresa -> Passa obrigatoriamente pela coleta de dados
          session.mode = 'COLETANDO_DADOS';
          inst.userStates.set(remoteJid, session);
          await sock.sendMessage(remoteJid, { text: `${inst.config.empresaHeader}\n\n${inst.config.solicitarDadosMsg}` });
        } 
        else if (cleanText === '2') {
          // Escolheu Particular -> Ativa a IA livre
          session.mode = 'PARTICULAR';
          inst.userStates.set(remoteJid, session);
          await sock.sendMessage(remoteJid, { text: inst.config.particularIntro });
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
  });
}

// Rotas do Painel Web Multi-Instância
app.get('/', (req, res) => {
  let instancesHtml = '';
  instances.forEach((inst, id) => {
    instancesHtml += `
      <div style="background: #334155; padding: 15px; border-radius: 8px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <strong>ID: ${id}</strong> (${inst.config.name})<br>
          <span style="color: #38bdf8; font-size: 0.9em;">Status: ${inst.status}</span>
        </div>
        <div>
          <a href="/instancia/${id}" style="background: #2563eb; color: white; padding: 8px 15px; text-decoration: none; border-radius: 6px; font-weight: bold;">Gerenciar / QR Code</a>
        </div>
      </div>
    `;
  });

  res.send(`
    <html>
      <head>
        <title>Painel Multi-Números - WhatsApp + IA</title>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
          .container { max-width: 700px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
          h1 { color: #38bdf8; text-align: center; }
          input { width: 100%; background: #0f172a; color: #fff; border: 1px solid #475569; padding: 10px; border-radius: 6px; margin-top: 5px; margin-bottom: 15px; }
          button { background: #10b981; color: white; border: none; padding: 12px 20px; font-size: 1em; font-weight: bold; border-radius: 6px; cursor: pointer; width: 100%; }
          button:hover { background: #059669; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📱 Gerenciador WhatsApp + IA</h1>
          <p style="text-align: center; color: #94a3b8;">Empresa com dados obrigatórios + Particular com Inteligência Artificial.</p>
          
          <h3 style="margin-top: 30px;">Instâncias Cadastradas:</h3>
          ${instancesHtml || '<p>Nenhuma instância criada ainda.</p>'}

          <h3 style="margin-top: 35px;">➕ Adicionar Nova Instância</h3>
          <form action="/create" method="POST">
            <label>Identificador Único (ex: comercial, suporte):</label>
            <input type="text" name="instanceId" required placeholder="ex: matriz" />
            <label>Nome Amigável:</label>
            <input type="text" name="instanceName" required placeholder="ex: Matriz SP" />
            <button type="submit">Criar Instância</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

app.post('/create', (req, res) => {
  const { instanceId, instanceName } = req.body;
  const cleanId = instanceId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (cleanId) {
    const inst = createInstance(cleanId);
    inst.config.name = instanceName || cleanId;
  }
  res.redirect('/');
});

app.get('/instancia/:id', async (req, res) => {
  const id = req.params.id;
  const inst = instances.get(id);

  if (!inst) return res.send('Instância não encontrada. <a href="/">Voltar</a>');

  let qrSection = '<p style="color: #fbbf24;">Aguardando QR Code...</p>';
  if (inst.qr && inst.status.includes('QR Code')) {
    try {
      const qrImage = await qrcode.toDataURL(inst.qr);
      qrSection = `
        <h3>Escaneie o QR Code:</h3>
        <img src="${qrImage}" alt="QR Code" style="background: white; padding: 10px; border-radius: 8px; width: 220px; height: 220px;" />
      `;
    } catch (e) {
      qrSection = '<p>Erro ao gerar imagem QR.</p>';
    }
  } else if (inst.status.includes('Conectado')) {
    qrSection = '<h3 style="color: #22c55e;">✅ WhatsApp Conectado com Sucesso!</h3>';
  }

  res.send(`
    <html>
      <head>
        <title>Configurar - ${inst.config.name}</title>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
          .container { max-width: 750px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
          h1 { color: #38bdf8; text-align: center; }
          .status-box { background: #334155; padding: 15px; border-radius: 8px; text-align: center; font-weight: bold; margin-bottom: 25px; }
          label { display: block; color: #cbd5e1; font-weight: bold; font-size: 0.9em; margin-top: 15px; }
          textarea, input { width: 100%; background: #0f172a; color: #fff; border: 1px solid #475569; padding: 10px; border-radius: 6px; margin-top: 5px; font-family: sans-serif; }
          textarea { height: 75px; }
          button { background: #2563eb; color: white; border: none; padding: 12px 20px; font-size: 1em; font-weight: bold; border-radius: 6px; cursor: pointer; width: 100%; margin-top: 25px; }
          button:hover { background: #1d4ed8; }
          .back { display: inline-block; margin-bottom: 20px; color: #38bdf8; text-decoration: none; font-weight: bold; }
          .qr-container { text-align: center; margin-bottom: 25px; background: #334155; padding: 20px; border-radius: 8px; }
        </style>
      </head>
      <body>
        <div class="container">
          <a href="/" class="back">← Voltar</a>
          <h1>⚙️ Configuração: ${inst.config.name} (${id})</h1>
          <div class="status-box">Status: ${inst.status}</div>

          <div class="qr-container">
            ${qrSection}
          </div>

          <form action="/instancia/${id}/save" method="POST">
            <h3>🤖 Configuração da IA (Para Opção Particular)</h3>
            <label>Chave API OpenAI (sk-...):</label>
            <input type="password" name="openaiApiKey" value="${inst.config.openaiApiKey}" placeholder="sk-..." />
            <label>Instrução / Prompt da IA:</label>
            <textarea name="aiPrompt">${inst.config.aiPrompt}</textarea>

            <h3 style="margin-top: 35px;">🏢 Empresa (Coleta de Dados Obrigatória)</h3>
            <label>Mensagem de Solicitação de Dados:</label>
            <textarea name="solicitarDadosMsg">${inst.config.solicitarDadosMsg}</textarea>

            <h3 style="margin-top: 35px;">📋 Menu da Empresa (Itens 1 a 3 Obrigatórios)</h3>
            <label>Item 1:</label>
            <input type="text" name="item1" value="${inst.config.item1}" />
            <label>Resposta Item 1:</label>
            <textarea name="resp1">${inst.config.resp1}</textarea>

            <label>Item 2:</label>
            <input type="text" name="item2" value="${inst.config.item2}" />
            <label>Resposta Item 2:</label>
            <textarea name="resp2">${inst.config.resp2}</textarea>

            <label>Item 3:</label>
            <input type="text" name="item3" value="${inst.config.item3}" />
            <label>Resposta Item 3:</label>
            <textarea name="resp3">${inst.config.resp3}</textarea>

            <h3 style="margin-top: 35px;">⚠️ Opção de Falha (Fallback)</h3>
            <textarea name="falhaMsg">${inst.config.falhaMsg}</textarea>

            <button type="submit">Salvar Configurações</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

app.post('/instancia/:id/save', (req, res) => {
  const id = req.params.id;
  const inst = instances.get(id);

  if (inst) {
    inst.config.openaiApiKey = req.body.openaiApiKey || inst.config.openaiApiKey;
    inst.config.aiPrompt = req.body.aiPrompt || inst.config.aiPrompt;
    inst.config.solicitarDadosMsg = req.body.solicitarDadosMsg || inst.config.solicitarDadosMsg;
    inst.config.item1 = req.body.item1 || inst.config.item1;
    inst.config.resp1 = req.body.resp1 || inst.config.resp1;
    inst.config.item2 = req.body.item2 || inst.config.item2;
    inst.config.resp2 = req.body.resp2 || inst.config.resp2;
    inst.config.item3 = req.body.item3 || inst.config.item3;
    inst.config.resp3 = req.body.resp3 || inst.config.resp3;
    inst.config.falhaMsg = req.body.falhaMsg || inst.config.falhaMsg;
  }

  res.redirect(`/instancia/${id}`);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  createInstance('principal');
});
