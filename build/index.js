#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { parseStringPromise } from 'xml2js';
import pg from 'pg';
// Configurações
const PORT = process.env.WEBHOOK_PORT || 3000;
const WEBHOOK_URL_BASE = process.env.WEBHOOK_URL_BASE || `http://localhost:${PORT}`;
// Configuração do PostgreSQL
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:W020kCWMosb7kv9QtCQAiHaKDG0oZBfs@206.183.128.152:5432/supabase?sslmode=disable';
const pool = new pg.Pool({
    connectionString: DATABASE_URL
});
// Função para salvar venda no banco
async function salvarVenda(dados) {
    try {
        const query = `
            INSERT INTO bali_park.vendas 
            (nome, cpf, telefone, email, voucher_code, valor_total, link_pagamento, sale_id, data_visita)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `;
        const values = [
            dados.nome,
            dados.cpf,
            dados.telefone,
            dados.email,
            dados.voucherCode,
            dados.valorTotal,
            dados.linkPagamento,
            dados.saleId,
            dados.dataVisita
        ];
        const result = await pool.query(query, values);
        console.log(`[DB] Venda salva com ID: ${result.rows[0].id}`);
        return result.rows[0].id;
    }
    catch (error) {
        console.error(`[DB] Erro ao salvar venda:`, error.message);
        throw error;
    }
}
// Armazenamento temporário para as promessas de venda
const pendingSales = new Map();
// Configura servidor Express
const app = express();
// Middleware de JSON para rotas específicas (não para /mcp que precisa do body raw)
const jsonParser = express.json();
// Configurações da API SOAP
const URL_API = 'https://multiclubes.balipark.com.br/(a655f81b-8437-48ec-8876-069664ee891a)/TicketsV2.svc';
const SOAP_ACTION_GET_TICKETS = 'http://multiclubes.com.br/tickets/v2/IService/GetTickets';
const SOAP_ACTION_SELL = 'http://multiclubes.com.br/tickets/v2/IService/Sell';
const AUTH_KEY = '3fe6ca43-65cc-4776-9fb8-667855dbd6e0';
// Agente HTTPS permissivo
const agent = new https.Agent({
    rejectUnauthorized: false,
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT:@SECLEVEL=0'
});
// Create an MCP server
const server = new McpServer({
    name: "multiclube-server",
    version: "1.0.0"
});
// Helper para listar tickets (reutilizável)
async function getTicketsDisponiveis(dataVisita) {
    const soapRequest = `
        <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v2="http://multiclubes.com.br/tickets/v2">
            <soapenv:Header>
                <_AuthenticationKey xmlns="ns">${AUTH_KEY}</_AuthenticationKey>
            </soapenv:Header>
            <soapenv:Body>
                <v2:GetTickets>
                    <v2:data>
                        <v2:VisitDate>${dataVisita}</v2:VisitDate>
                    </v2:data>
                </v2:GetTickets>
            </soapenv:Body>
        </soapenv:Envelope>
    `;
    const response = await axios.post(URL_API, soapRequest, {
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': SOAP_ACTION_GET_TICKETS
        },
        httpsAgent: agent
    });
    const parsed = await parseStringPromise(response.data, { explicitArray: false, ignoreAttrs: true });
    const tickets = [];
    try {
        const result = parsed['s:Envelope']['s:Body'].GetTicketsResponse.GetTicketsResult;
        const planos = Array.isArray(result.PlanTicketResult) ? result.PlanTicketResult : [result.PlanTicketResult];
        for (const plano of planos) {
            if (plano.Tickets && plano.Tickets.TicketResult) {
                const ticketsPlano = Array.isArray(plano.Tickets.TicketResult) ? plano.Tickets.TicketResult : [plano.Tickets.TicketResult];
                for (const ticket of ticketsPlano) {
                    tickets.push({
                        id: ticket.TicketId,
                        nome: ticket.Description,
                        valor: parseFloat(ticket.Value),
                        plano: plano.Description
                    });
                }
            }
        }
    }
    catch (e) {
        console.error("Erro ao fazer parse dos tickets:", e);
    }
    return { raw: parsed, simplified: tickets };
}
// Helper para obter data atual no formato AAAA-MM-DD (timezone Brasil)
function getDataAtualBrasil() {
    const now = new Date();
    // Ajusta para timezone de Brasília (UTC-3)
    const brasilOffset = -3 * 60;
    const localOffset = now.getTimezoneOffset();
    const brasilTime = new Date(now.getTime() + (localOffset - brasilOffset) * 60000);
    return brasilTime.toISOString().split('T')[0];
}
// Helper para validar se a data não é passada
function validarDataFutura(dataVisita) {
    const hoje = getDataAtualBrasil();
    if (dataVisita < hoje) {
        return {
            valida: false,
            mensagem: `ERRO: A data informada (${dataVisita}) é uma data PASSADA. Hoje é ${hoje}. Por favor, informe uma data igual ou posterior a hoje.`
        };
    }
    return { valida: true };
}
// Helper para calcular dias de antecedência
function calcularDiasAntecedencia(dataVisita) {
    const hoje = new Date(getDataAtualBrasil());
    const visita = new Date(dataVisita);
    const diffTime = visita.getTime() - hoje.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}
// Helper para verificar se o ingresso é elegível para desconto
function isIngressoElegivelDesconto(nomeIngresso) {
    const nomeUpper = nomeIngresso.toUpperCase();
    return nomeUpper.includes('INGRESSO ADULTO') || nomeUpper.includes('INGRESSO INFANTIL');
}
// Helper para calcular desconto de antecipação
// Até 10 dias: 10% | Mais de 10 dias: 14%
// Aplica apenas em INGRESSO ADULTO e INGRESSO INFANTIL
// Arredonda para cima
function calcularValorComDesconto(valorOriginal, nomeIngresso, diasAntecedencia) {
    // Verifica se é elegível para desconto
    if (!isIngressoElegivelDesconto(nomeIngresso)) {
        return {
            valorFinal: valorOriginal,
            desconto: 0,
            percentualDesconto: 0,
            temDesconto: false
        };
    }
    // Define percentual baseado na antecedência
    const percentualDesconto = diasAntecedencia > 10 ? 14 : 10;
    // Calcula valor com desconto e arredonda para cima
    const valorComDesconto = valorOriginal * (1 - percentualDesconto / 100);
    const valorFinal = Math.ceil(valorComDesconto);
    const desconto = valorOriginal - valorFinal;
    return {
        valorFinal,
        desconto,
        percentualDesconto,
        temDesconto: true
    };
}
// Ferramenta: Listar Tickets
server.tool("listar_tickets", {
    dataVisita: z.string().describe(`Data da visita no formato AAAA-MM-DD. IMPORTANTE: A data atual é ${getDataAtualBrasil()}. Não aceite datas passadas. Para "amanhã", calcule a data correta a partir de hoje. Obrigatório para consultar a disponibilidade e preços dos ingressos.`)
}, async ({ dataVisita }) => {
    // Validação de data passada ANTES de chamar a API
    const validacao = validarDataFutura(dataVisita);
    if (!validacao.valida) {
        return {
            content: [{
                    type: "text",
                    text: validacao.mensagem
                }],
            isError: true
        };
    }
    try {
        const result = await getTicketsDisponiveis(dataVisita);
        // Calcula dias de antecedência para o desconto
        const diasAntecedencia = calcularDiasAntecedencia(dataVisita);
        // Calcula o dia da semana
        const diasSemana = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
        const dataObj = new Date(dataVisita + 'T12:00:00');
        const diaSemana = diasSemana[dataObj.getDay()];
        // Formata o retorno de forma limpa para a LLM (valores já com desconto aplicado internamente)
        const planosFormatados = result.simplified.reduce((acc, ticket) => {
            // Agrupa por plano
            let plano = acc.find(p => p.plano === ticket.plano);
            if (!plano) {
                plano = { plano: ticket.plano, tickets: [] };
                acc.push(plano);
            }
            // Aplica desconto internamente (invisível para a LLM)
            const descontoInfo = calcularValorComDesconto(ticket.valor, ticket.nome, diasAntecedencia);
            plano.tickets.push({
                ticketId: ticket.id,
                descricao: ticket.nome,
                valor: descontoInfo.valorFinal
            });
            return acc;
        }, []);
        // Verifica se a consulta é para o dia atual
        const hoje = getDataAtualBrasil();
        const isHoje = dataVisita === hoje;
        const resposta = {
            dataConsultada: dataVisita,
            diaSemana: diaSemana,
            planos: planosFormatados
        };
        // Adiciona informação especial para compras do dia atual
        if (isHoje) {
            resposta.informacaoEspecial = "Como a compra é para o mesmo dia da visita, você consegue comprar no link: https://loja.multiclubes.com.br/balipark/Ingressos/CP0025?Promoter=aWFmSjE1SnI3MW8vRzN0RlI0WjVDZz09 onde já terá o desconto aplicado.";
        }
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify(resposta, null, 2)
                }]
        };
    }
    catch (error) {
        return {
            content: [{
                    type: "text",
                    text: `Erro ao listar tickets: ${error.message}`
                }],
            isError: true
        };
    }
});
// Ferramenta: Gerar Venda
server.tool("gerar_venda", "Gera uma venda de ingressos e retorna o link de pagamento. IMPORTANTE: Esta ferramenta aceita APENAS os campos listados abaixo. NÃO adicione campos extras como 'id', 'transactionId' ou qualquer outro não especificado.", {
    itens: z.array(z.object({
        ticketId: z.string().describe("ID do ticket (string) obtido do campo 'ticketId' retornado pela ferramenta listar_tickets"),
        quantidade: z.number().min(1).describe("Quantidade de ingressos deste tipo (número inteiro >= 1)")
    })).min(1).describe("Array de objetos representando os ingressos. Cada objeto deve ter APENAS 'ticketId' (string) e 'quantidade' (number). Exemplo: [{\"ticketId\": \"823813\", \"quantidade\": 2}]"),
    dataVisita: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`Data da visita no formato AAAA-MM-DD (ex: 2026-01-15). Data atual: ${getDataAtualBrasil()}. Não aceite datas passadas.`),
    compradorNome: z.string().min(3).describe("Nome completo do comprador (mínimo 3 caracteres)"),
    compradorDocumento: z.string().regex(/^\d{11}$/).describe("CPF do comprador com 11 dígitos numéricos, SEM pontuação."),
    compradorEmail: z.string().email().describe("Email válido do comprador para envio do voucher."),
    compradorTelefone: z.string().regex(/^\d{10,11}$/).describe("Telefone com DDD, 10 ou 11 dígitos numéricos SEM pontuação.")
}, async ({ itens, dataVisita, compradorNome, compradorDocumento, compradorEmail, compradorTelefone }) => {
    // Validação de data passada ANTES de processar
    const validacao = validarDataFutura(dataVisita);
    if (!validacao.valida) {
        return {
            content: [{
                    type: "text",
                    text: validacao.mensagem
                }],
            isError: true
        };
    }
    // Verifica se a venda é para o dia atual
    const hojeVenda = getDataAtualBrasil();
    const isHoje = dataVisita === hojeVenda;
    if (isHoje) {
        return {
            content: [{
                    type: "text",
                    text: "Como a compra é para o mesmo dia da visita, o sistema de antecipação não permite emitir a venda diretamente, mas você consegue adquirir com o mesmo desconto no link: https://loja.multiclubes.com.br/balipark/Ingressos/CP0025?Promoter=aWFmSjE1SnI3MW8vRzN0RlI0WjVDZz09."
                }],
            isError: false
        };
    }
    const transactionId = crypto.randomUUID();
    const webhookUrl = `${WEBHOOK_URL_BASE}/webhook/${transactionId}`;
    // 1. Buscar preços atuais na API
    let ticketsDisponiveis;
    try {
        const result = await getTicketsDisponiveis(dataVisita);
        ticketsDisponiveis = result.simplified;
    }
    catch (error) {
        return {
            content: [{
                    type: "text",
                    text: `Erro ao consultar valores dos ingressos para a data ${dataVisita}: ${error.message}`
                }],
            isError: true
        };
    }
    // 2. Montar itens da venda com valores validados (com desconto aplicado)
    const diasAntecedencia = calcularDiasAntecedencia(dataVisita);
    const itensComValor = [];
    let valorTotal = 0;
    for (const item of itens) {
        const ticketInfo = ticketsDisponiveis.find((t) => t.id === item.ticketId);
        if (!ticketInfo) {
            return {
                content: [{
                        type: "text",
                        text: `Erro: O Ticket ID '${item.ticketId}' não está disponível para a data ${dataVisita}.`
                    }],
                isError: true
            };
        }
        // Aplica desconto se elegível
        const descontoInfo = calcularValorComDesconto(ticketInfo.valor, ticketInfo.nome, diasAntecedencia);
        const valorItem = descontoInfo.valorFinal;
        valorTotal += valorItem * item.quantidade;
        itensComValor.push({
            ...item,
            valorUnitario: valorItem,
            valorOriginal: ticketInfo.valor,
            descontoAplicado: descontoInfo.temDesconto ? descontoInfo.percentualDesconto : 0
        });
    }
    // Promessa para aguardar webhook
    const promessaVenda = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingSales.delete(transactionId);
            reject(new Error("Timeout aguardando webhook de pagamento"));
        }, 60000);
        pendingSales.set(transactionId, { resolve, reject, timeout });
    });
    // Constrói os itens XML - DueValue do item é o valor UNITÁRIO
    const itemsXml = itensComValor.map(item => `
                                <v2:SaleItemData>
                                    <v2:Quantity>${item.quantidade}</v2:Quantity>
                                    <v2:TicketId>${item.ticketId}</v2:TicketId>
                                    <v2:Values>
                                        <v2:DueValue>${item.valorUnitario.toFixed(2)}</v2:DueValue>
                                    </v2:Values>
                                </v2:SaleItemData>
        `).join('\n');
    const visitorXml = `
                            <v2:Visitor>
                                <v2:Document>${compradorDocumento}</v2:Document>
                                <v2:Email>${compradorEmail}</v2:Email>
                                <v2:Name>${compradorNome}</v2:Name>
                                <v2:PhoneNumber>${compradorTelefone}</v2:PhoneNumber>
                            </v2:Visitor>
        `;
    // Calcula DueDays baseado na diferença entre hoje e a data da visita
    const hojeCalculo = new Date(getDataAtualBrasil());
    const visita = new Date(dataVisita);
    const diffTime = visita.getTime() - hojeCalculo.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    // DueDays deve ser no máximo a quantidade de dias até a visita, mínimo 1
    const dueDays = Math.max(1, Math.min(diffDays, 2));
    const soapRequest = `
            <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v2="http://multiclubes.com.br/tickets/v2">
                <soapenv:Header>
                    <_AuthenticationKey xmlns="ns">${AUTH_KEY}</_AuthenticationKey>
                </soapenv:Header>
                <soapenv:Body>
                    <v2:Sell>
                        <v2:data>
                            <v2:PaymentLink>
                                <v2:DueDays>${dueDays}</v2:DueDays>
                                <v2:WebhookUrl>${webhookUrl}</v2:WebhookUrl>
                            </v2:PaymentLink>
                            <v2:Tickets>
                                ${itemsXml}
                            </v2:Tickets>
                            <v2:Values>
                                <v2:DueValue>${valorTotal.toFixed(2)}</v2:DueValue>
                            </v2:Values>
                            <v2:VisitDate>${dataVisita}</v2:VisitDate>
                            ${visitorXml}
                        </v2:data>
                    </v2:Sell>
                </soapenv:Body>
            </soapenv:Envelope>
        `;
    try {
        console.error(`[GerarVenda] Enviando requisição SOAP...`);
        console.error(`[GerarVenda] XML Request:\n${soapRequest}`);
        const response = await axios.post(URL_API, soapRequest, {
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': SOAP_ACTION_SELL
            },
            httpsAgent: agent
        });
        const parsed = await parseStringPromise(response.data, { explicitArray: false, ignoreAttrs: true });
        console.error(`[GerarVenda] Resposta SOAP recebida. Aguardando webhook...`);
        const webhookData = await promessaVenda;
        // Extrai dados relevantes da resposta SOAP
        const sellResult = parsed['s:Envelope']?.['s:Body']?.SellResponse?.SellResult;
        const saleId = sellResult?.SaleId;
        const ticketsResult = sellResult?.Tickets?.SaleItemResult;
        const ingressos = Array.isArray(ticketsResult) ? ticketsResult : [ticketsResult];
        // Formata retorno limpo para a LLM
        // Salva a venda no banco de dados
        try {
            await salvarVenda({
                nome: compradorNome,
                cpf: compradorDocumento,
                telefone: compradorTelefone,
                email: compradorEmail,
                voucherCode: webhookData?.data?.voucherCode || '',
                valorTotal: webhookData?.data?.value || valorTotal,
                linkPagamento: webhookData?.data?.url || '',
                saleId: saleId || '',
                dataVisita: dataVisita
            });
        }
        catch (dbError) {
            console.error(`[GerarVenda] Erro ao salvar no banco (venda continuará):`, dbError.message);
        }
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        sucesso: true,
                        venda: {
                            saleId: saleId,
                            ingressos: ingressos.map((ing) => ({
                                ticketId: ing.TicketId,
                                codigoAcesso: ing.AccessCode
                            }))
                        },
                        pagamento: {
                            voucherCode: webhookData?.data?.voucherCode,
                            valorTotal: webhookData?.data?.value,
                            vencimento: webhookData?.data?.dueDate,
                            linkPagamento: webhookData?.data?.url
                        }
                    }, null, 2)
                }]
        };
    }
    catch (error) {
        if (pendingSales.has(transactionId)) {
            clearTimeout(pendingSales.get(transactionId).timeout);
            pendingSales.delete(transactionId);
        }
        // Captura detalhes do erro da API
        let errorDetails = error.message;
        if (error.response) {
            console.error(`[GerarVenda] Status: ${error.response.status}`);
            console.error(`[GerarVenda] Response Data:`, error.response.data);
            errorDetails = `Status ${error.response.status}: ${error.response.data || error.message}`;
        }
        return {
            content: [{
                    type: "text",
                    text: `Erro ao gerar venda: ${errorDetails}`
                }],
            isError: true
        };
    }
});
// Armazena sessões de transporte ativas (para stateful sessions)
const transports = new Map();
// Endpoint MCP - HTTP Streamable (único endpoint para todas as operações)
app.all('/mcp', async (req, res) => {
    console.log(`[MCP] ${req.method} request received`);
    // Obtém ou cria session ID
    const sessionId = req.headers['mcp-session-id'];
    let transport;
    if (sessionId && transports.has(sessionId)) {
        // Reutiliza transporte existente
        transport = transports.get(sessionId);
        console.log(`[MCP] Reusing session: ${sessionId}`);
    }
    else if (req.method === 'POST' || req.method === 'GET') {
        // Cria novo transporte para nova sessão
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (newSessionId) => {
                console.log(`[MCP] New session initialized: ${newSessionId}`);
                transports.set(newSessionId, transport);
            }
        });
        // Conecta o servidor MCP ao transporte
        await server.connect(transport);
        // Limpa sessão quando fechada
        transport.onclose = () => {
            const sid = Array.from(transports.entries()).find(([_, t]) => t === transport)?.[0];
            if (sid) {
                console.log(`[MCP] Session closed: ${sid}`);
                transports.delete(sid);
            }
        };
    }
    else {
        // Método não suportado sem sessão
        res.status(400).json({ error: 'Bad Request: No valid session' });
        return;
    }
    // Delega o handling para o transporte
    try {
        await transport.handleRequest(req, res);
    }
    catch (error) {
        console.error(`[MCP] Error handling request:`, error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});
// Endpoint DELETE para encerrar sessão
app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId);
        await transport.close();
        transports.delete(sessionId);
        console.log(`[MCP] Session terminated: ${sessionId}`);
        res.status(200).json({ message: 'Session terminated' });
    }
    else {
        res.status(404).json({ error: 'Session not found' });
    }
});
// Webhook endpoint para receber callbacks de pagamento
// Usa raw body para debug e depois parseia manualmente
app.post('/webhook/:transactionId', express.raw({ type: '*/*' }), (req, res) => {
    const { transactionId } = req.params;
    console.error(`[Webhook] Recebido callback para transactionId: ${transactionId}`);
    console.error(`[Webhook] Headers:`, JSON.stringify(req.headers, null, 2));
    console.error(`[Webhook] Raw Body:`, req.body?.toString?.() || req.body);
    // Tenta parsear o body como JSON
    let parsedBody = {};
    try {
        let bodyStr = '';
        if (Buffer.isBuffer(req.body)) {
            bodyStr = req.body.toString();
        }
        else if (typeof req.body === 'string') {
            bodyStr = req.body;
        }
        else if (typeof req.body === 'object') {
            parsedBody = req.body;
        }
        if (bodyStr) {
            // Corrige o formato brasileiro de número (167,00 -> 167.00)
            // Regex: encontra números com vírgula decimal e substitui por ponto
            bodyStr = bodyStr.replace(/(\d+),(\d{2})(\s*[}\],])/g, '$1.$2$3');
            parsedBody = JSON.parse(bodyStr);
        }
    }
    catch (e) {
        console.error(`[Webhook] Erro ao parsear body:`, e);
    }
    console.error(`[Webhook] Parsed Body:`, JSON.stringify(parsedBody, null, 2));
    if (pendingSales.has(transactionId)) {
        const { resolve, timeout } = pendingSales.get(transactionId);
        clearTimeout(timeout);
        resolve(parsedBody); // Usa o body parseado
        pendingSales.delete(transactionId);
        res.status(200).send('OK');
    }
    else {
        console.error(`[Webhook] Nenhuma transação pendente para: ${transactionId}`);
        res.status(404).send('Not Found');
    }
});
// Health check
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', transport: 'streamable-http' });
});
// Inicia o servidor
app.listen(PORT, () => {
    console.log(`MultiClube MCP Server running on port ${PORT}`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
