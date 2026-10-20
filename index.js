const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Gerenciador de múltiplas instâncias em memória e disco
// Estrutura: instances.get(instanceId) = { sock, qr, status, config, userStates }
const instances = new Map();
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Configuração padrão para uma instância
function getDefaultConfig() {
  return {
    name: "Nova Instância",
    // Configurações do menu Empresa (Itens 1 ao 3 obrigatórios + Falha + Config)
    empresaHeader: "🏢 *Menu Empresa - Atendimento Oficial*",
    item1: "1️⃣ - Setor Comercial / Vendas",
    resp1: "📦 *Comercial:* Nossos planos e produtos atendem todo o Brasil. Como podemos ajudar?",
    item2: "2️⃣ - Suporte Técnico",
    resp2: "🛠️ *Suporte:* Envie sua dúvida detalhada ou descreva o problema técnico.",
    item3: "3️⃣ - Financeiro / Faturamento",
    resp3: "💰 *Financeiro:* Para 2ª via de boleto ou notas fiscais, envie seu CNPJ/CPF.",
    
    // Mensagem de Falha (Fallback quando erra a opção)
    falhaMsg: "❌ *Opção inválida!* Por favor, escolha obrigatoriamente uma das opções válidas do menu (1, 2 ou 3).",
    
    // Configurações (Fora da sequência / Administrativo)
    configTrigger: "#config",
    configResp: "⚙️ *Painel de Configuração Interna da Empresa:* Modo administrativo ativo.",

    // Configuração da Opção Particular (Mensagem aberta liberada)
    particularResp: "💬 *Atendimento Particular Ativado!* A partir de agora a conversa está livre para troca de mensagens abertas."
  };
}

// Inicializar ou carregar instâncias salvas
function createInstance(instanceId) {
  if (instances.has(instanceId)) {
    return instances.get(instanceId);
  }

  const sessionPath = path.join(SESSIONS_DIR, instanceId);
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  const instanceData = {
    id: instanceId,
    sock: null,
    qr: '',
    status: 'Iniciando...',
    config: getDefaultConfig(),
    userStates: new Map() // Jid -> { mode: 'INICIAL' | 'EMPRESA' | 'PARTICULAR', step: ... }
  };

  instances.set(instanceId, instanceData);
  startWhatsAppInstance(instanceData, sessionPath);
  return instanceData;
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
      if (shouldReconnect) {
        startWhatsAppInstance(inst, sessionPath);
      }
    } else if (connection === 'open') {
      inst.status = 'Conectado com sucesso ao WhatsApp! 🟢';
      inst.qr = '';
    }
  });

  // Motor de Regras e Estados da Instância
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

      let session = inst.userStates.get(remoteJid) || { mode: 'INICIAL' };

      // Comando universal de retorno ao menu inicial
      if (cleanText === '#' || cleanText.toLowerCase() === '#menu') {
        inst.userStates.set(remoteJid, { mode: 'INICIAL' });
        const menuInicial = 
          `🤖 *Olá! Seja bem-vindo(a).*\n\nComo deseja ser atendido?\n\n` +
          `1️⃣ - Empresa (Atendimento Direcionado)\n` +
          `2️⃣ - Particular (Conversa Aberta / Livre)`;
        await sock.sendMessage(remoteJid, { text: `🔄 Retornando ao menu principal...\n\n` + menuInicial });
        continue;
      }

      // Se estiver no modo PARTICULAR -> Mensagem Aberta / Livre total
      if (session.mode === 'PARTICULAR') {
        console.log(`[PARTICULAR] Mensagem aberta de ${remoteJid}: "${cleanText}"`);
        // Conversa livre liberada sem travas
        continue;
      }

      // Se estiver no modo EMPRESA -> Itens 1 ao 3 obrigatórios, falha e config
      if (session.mode === 'EMPRESA') {
        // Verificar gatilho de Configuração (fora da sequência)
        if (cleanText.toLowerCase() === inst.config.configTrigger.toLowerCase()) {
          await sock.sendMessage(remoteJid, { text: inst.config.configResp + "\n\n*(Digite # para voltar)*" });
          continue;
        }

        // Validação Obrigatória dos Itens 1 ao 3
        if (cleanText === '1') {
          await sock.sendMessage(remoteJid, { text: inst.config.resp1.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*" });
        } else if (cleanText === '2') {
          await sock.sendMessage(remoteJid, { text: inst.config.resp2.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*" });
        } else if (cleanText === '3') {
          await sock.sendMessage(remoteJid, { text: inst.config.resp3.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*" });
        } else {
          // OPÇÃO DE FALHA (Fallback obrigatório para entradas incorretas na Empresa)
          const menuEmpresa = 
            `${inst.config.empresaHeader}\n\n` +
            `${inst.config.item1}\n${inst.config.item2}\n${inst.config.item3}\n\n` +
            `⚠️ *(Digite # para voltar ao início)*`;

          await sock.sendMessage(remoteJid, { text: `${inst.config.falhaMsg}\n\n` + menuEmpresa });
        }
        continue;
      }

      // Modo INICIAL (Escolha entre Empresa ou Particular)
      if (session.mode === 'INICIAL') {
        if (cleanText === '1') {
          inst.userStates.set(remoteJid, { mode: 'EMPRESA' });
          const menuEmpresa = 
            `${inst.config.empresaHeader}\n\n` +
            `${inst.config.item1}\n${inst.config.item2}\n${inst.config.item3}\n\n` +
            `*(Digite o número da opção desejada ou # para voltar)*`;
          await sock.sendMessage(remoteJid, { text: menuEmpresa });
        } 
        else if (cleanText === '2') {
          inst.userStates.set(remoteJid, { mode: 'PARTICULAR' });
          await sock.sendMessage(remoteJid, { text: inst.config.particularResp });
        } 
        else {
          // Falha na escolha inicial
          const menuInicial = 
            `❌ *Opção inválida!*\n\nPor favor, escolha uma opção válida:\n\n` +
            `1️⃣ - Empresa (Atendimento Direcionado)\n` +
            `2️⃣ - Particular (Conversa Aberta / Livre)`;
          await sock.sendMessage(remoteJid, { text: menuInicial });
        }
      }
    }
  });
}

// Painel Web Principal (Lista de Instâncias e Criação de Novos Números)
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
        <title>Painel Multi-Números - WhatsApp</title>
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
          <h1>📱 Gerenciador Multi-Números</h1>
          <p style="text-align: center; color: #94a3b8;">Cada número possui seu próprio QR Code isolado e regras de menu exclusivas.</p>
          
          <h3 style="margin-top: 30px;">Instâncias Cadastradas:</h3>
          ${instancesHtml || '<p>Nenhuma instância criada ainda.</p>'}

          <h3 style="margin-top: 35px;">➕ Adicionar Novo Número / Instância</h3>
          <form action="/create" method="POST">
            <label>Identificador Único (ex: loja-sp, atendente-1):</label>
            <input type="text" name="instanceId" required placeholder="ex: suporte-rj" />
            <label>Nome Amigável:</label>
            <input type="text" name="instanceName" required placeholder="ex: Suporte Rio de Janeiro" />
            <button type="submit">Criar Nova Instância</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

// Criar nova instância
app.post('/create', (req, res) => {
  const { instanceId, instanceName } = req.body;
  const cleanId = instanceId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (cleanId) {
    const inst = createInstance(cleanId);
    inst.config.name = instanceName || cleanId;
  }
  res.redirect('/');
});

// Painel Específico da Instância (QR Code + Configurações de Menu Empresa / Falha / Config / Particular)
app.get('/instancia/:id', async (req, res) => {
  const id = req.params.id;
  const inst = instances.get(id);

  if (!inst) {
    return res.send('Instância não encontrada. <a href="/">Voltar</a>');
  }

  let qrSection = '<p style="color: #fbbf24;">Aguardando geração do QR Code...</p>';
  if (inst.qr && inst.status.includes('QR Code')) {
    try {
      const qrImage = await qrcode.toDataURL(inst.qr);
      qrSection = `
        <h3>Escaneie o QR Code com o WhatsApp deste número:</h3>
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
          <a href="/" class="back">← Voltar para Lista de Instâncias</a>
          <h1>⚙️ Configuração: ${inst.config.name} (${id})</h1>
          <div class="status-box">Status: ${inst.status}</div>

          <div class="qr-container">
            ${qrSection}
          </div>

          <form action="/instancia/${id}/save" method="POST">
            <h3>🏢 Menu Empresa (Obrigatório Itens 1 ao 3)</h3>
            <label>Cabeçalho da Empresa:</label>
            <textarea name="empresaHeader">${inst.config.empresaHeader}</textarea>

            <label>Item 1 (Título):</label>
            <input type="text" name="item1" value="${inst.config.item1}" />
            <label>Resposta do Item 1:</label>
            <textarea name="resp1">${inst.config.resp1}</textarea>

            <label>Item 2 (Título):</label>
            <input type="text" name="item2" value="${inst.config.item2}" />
            <label>Resposta do Item 2:</label>
            <textarea name="resp2">${inst.config.resp2}</textarea>

            <label>Item 3 (Título):</label>
            <input type="text" name="item3" value="${inst.config.item3}" />
            <label>Resposta do Item 3:</label>
            <textarea name="resp3">${inst.config.resp3}</textarea>

            <h3 style="margin-top: 35px;">⚠️ Opção de Falha (Fallback)</h3>
            <label>Mensagem quando cliente digita opção inválida na Empresa:</label>
            <textarea name="falhaMsg">${inst.config.falhaMsg}</textarea>

            <h3 style="margin-top: 35px;">⚙️ Opção de Configuração (Fora da Sequência)</h3>
            <label>Comando gatilho (ex: #config):</label>
            <input type="text" name="configTrigger" value="${inst.config.configTrigger}" />
            <label>Resposta de Configuração:</label>
            <textarea name="configResp">${inst.config.configResp}</textarea>

            <h3 style="margin-top: 35px;">💬 Opção Particular (Conversa Aberta)</h3>
            <label>Mensagem ao escolher Particular:</label>
            <textarea name="particularResp">${inst.config.particularResp}</textarea>

            <button type="submit">Salvar Configurações da Instância</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

// Salvar configurações da instância
app.post('/instancia/:id/save', (req, res) => {
  const id = req.params.id;
  const inst = instances.get(id);

  if (inst) {
    inst.config.empresaHeader = req.body.empresaHeader || inst.config.empresaHeader;
    inst.config.item1 = req.body.item1 || inst.config.item1;
    inst.config.resp1 = req.body.resp1 || inst.config.resp1;
    inst.config.item2 = req.body.item2 || inst.config.item2;
    inst.config.resp2 = req.body.resp2 || inst.config.resp2;
    inst.config.item3 = req.body.item3 || inst.config.item3;
    inst.config.resp3 = req.body.resp3 || inst.config.resp3;
    inst.config.falhaMsg = req.body.falhaMsg || inst.config.falhaMsg;
    inst.config.configTrigger = req.body.configTrigger || inst.config.configTrigger;
    inst.config.configResp = req.body.configResp || inst.config.configResp;
    inst.config.particularResp = req.body.particularResp || inst.config.particularResp;
  }

  res.redirect(`/instancia/${id}`);
});

app.listen(PORT, () => {
  console.log(`Servidor Multi-Instância rodando na porta ${PORT}`);
  // Criar uma instância padrão inicial para facilitar
  createInstance('principal');
});
