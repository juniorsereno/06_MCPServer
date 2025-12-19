const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');

// Configurações
const urlApi = 'https://multiclubes.balipark.com.br/(a655f81b-8437-48ec-8876-069664ee891a)/TicketsV2.svc';
const soapAction = 'http://multiclubes.com.br/tickets/v2/IService/GetTickets';
const arquivoPayload = path.join(__dirname, 'payload-tickets.xml');

async function listarTickets() {
    try {
        console.log(`Lendo arquivo ${arquivoPayload}...`);
        const xmlData = fs.readFileSync(arquivoPayload, 'utf8');

        // Configura um agente HTTPS ultra-permissivo
        const agent = new https.Agent({
            rejectUnauthorized: false,
            secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
            minVersion: 'TLSv1',
            ciphers: 'DEFAULT:@SECLEVEL=0'
        });

        console.log(`Enviando requisição para: ${urlApi}`);
        console.log(`Action: ${soapAction}`);

        const response = await axios.post(urlApi, xmlData, {
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': soapAction
            },
            httpsAgent: agent,
            timeout: 30000
        });

        console.log('\n--- Status da Resposta ---');
        console.log(`${response.status} ${response.statusText}`);
        
        console.log('\n--- Corpo da Resposta (Tickets Disponíveis) ---');
        console.log(response.data);

    } catch (error) {
        console.error('\nErro na requisição:');
        if (error.response) {
            console.log(`Status: ${error.response.status}`);
            console.log('Dados:', error.response.data);
        } else if (error.request) {
            console.log('Erro de rede/conexão:', error.message);
        } else {
            console.log('Erro:', error.message);
        }
    }
}

listarTickets();