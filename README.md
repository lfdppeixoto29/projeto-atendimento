# Projeto Atendimento WhatsApp (Multi-Número & Menu Estrito)

Este projeto foi criado sob medida na pasta `G:\projeto atendimento` e está pronto para garantir que o seu WhatsApp nunca perca a conexão (persistência em banco de dados) e que o menu seja rigorosamente seguido, bloqueando qualquer conversa livre indesejada.

---

## 🚀 Como Hospedar (Servidor Escolhido)

Para que o bot **nunca caia**, rode 24/7 na nuvem e gere o QR Code perfeitamente, o melhor serviço para deploy é o **Railway** (ou Render), utilizando o **Docker Compose** incluído neste projeto.

### Passo a Passo para o Deploy no Railway:

1. Acesse **[railway.app](https://railway.app)** e crie sua conta gratuita.
2. Crie um novo projeto e selecione **Deploy from GitHub repo** (ou suba os arquivos desta pasta para um repositório privado no seu GitHub) ou use o CLI do Railway.
3. O Railway vai detectar automaticamente o `docker-compose.yml` que criei na pasta `G:\projeto atendimento`. Ele vai subir:
   - **PostgreSQL** (com volume persistente para **nunca perder a sessão** do WhatsApp, mesmo se reiniciar ou atualizar).
   - **Evolution API v2** (o motor oficial do WhatsApp com QR Code).
   - **Chatbot Webhook** (o nosso código Node.js em `index.js` que gerencia o menu estrito e o bloqueio de conversas livres).

---

## 🔑 Onde colocar as Chaves de API

Na pasta `G:\projeto atendimento`, você encontrará os seguintes arquivos de configuração:

1. **`.env.example`** (Renomeie para `.env` se for rodar localmente ou configure as variáveis de ambiente diretamente no painel do Railway):
   ```env
   EVOLUTION_API_URL=https://sua-url-no-railway.up.railway.app
   EVOLUTION_API_KEY=sua_global_api_key_aqui
   INSTANCE_NAME=atendimento_principal
   ```

---

## 📱 Como Conectar o Celular (QR Code)

1. Após o deploy no Railway, a Evolution API estará rodando na URL gerada por eles.
2. Você pode criar/conectar sua instância fazendo uma requisição simples (ou usando o Evolution Manager / Postman):
   - **Criar Instância (`POST /instance/create`):**
     ```json
     {
       "instanceName": "atendimento_principal",
       "integration": "WHATSAPP-BAILEYS"
     }
     ```
   - **Conectar e pegar o QR Code (`GET /instance/connect/atendimento_principal`):**
     Basta acessar essa URL ou ler o QR Code retornado pela API na tela do seu navegador/painel.
3. Abra o seu WhatsApp no celular -> **Aparelhos Conectados** -> **Conectar Aparelho** e escaneie o QR Code. Pronto!

---

## 🛡️ Regras de Funcionamento Implementadas

- **Sessão 100% Persistente:** Salva todas as chaves de sessão no PostgreSQL com volume Docker, garantindo reconexão imediata e automática após qualquer reinicialização ou atualização.
- **Menu Estrito (Bloqueio de Conversa Livre):** Quando um cliente envia uma mensagem pela primeira vez, ele recebe o menu automático (Opções 1, 2 e 3). 
- **Rejeição a Textos Aleatórios:** Se o cliente digitar qualquer coisa que não seja `1`, `2` ou `3`, o bot **bloqueia** a conversa livre, avisa que a opção é inválida e repete o menu.
- **Exceção de Atendimento Humano/IA:** O cliente só consegue sair do menu engessado e falar livremente se digitar estritamente a **Opção 3** (ou digitar `#menu` para retornar ao menu principal a qualquer momento).
