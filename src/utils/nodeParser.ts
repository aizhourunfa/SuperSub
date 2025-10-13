import { Node } from '@/types';
import { v4 as uuidv4 } from 'uuid';

// Define a more specific type for a node that has been parsed but not yet saved to the DB.
export type ParsedNode = Omit<Node, 'id' | 'user_id' | 'group_id' | 'created_at' | 'updated_at' | 'sort_order' | 'status' | 'latency' | 'last_checked' | 'error'>;


// A robust Base64 decoder that handles URL-safe encoding and padding issues.
const base64Decode = (str: string): string => {
    let output = str.replace(/-/g, '+').replace(/_/g, '/');
    switch (output.length % 4) {
        case 0:
            break;
        case 2:
            output += '==';
            break;
        case 3:
            output += '=';
            break;
        default:
            throw new Error('Illegal base64url string!');
    }

    // Use TextDecoder for robust UTF-8 decoding, available in all modern JS environments (Browser, Node, CF Workers).
    try {
        const binaryString = atob(output);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return new TextDecoder().decode(bytes);
    } catch (e) {
        console.error('Failed to decode base64 string:', str, e);
        return '';
    }
};

const parseVmess = (link: string): ParsedNode | null => {
    if (!link.startsWith('vmess://')) return null;

    let data = link.substring(8);
    let encodedPart = data;
    let queryPart = '';

    const queryIndex = data.indexOf('?');
    if (queryIndex !== -1) {
        encodedPart = data.substring(0, queryIndex);
        queryPart = data.substring(queryIndex);
    }

    let decodedData: string;
    try {
        decodedData = base64Decode(encodedPart);
    } catch (e) {
        console.error('Base64 decoding failed for VMess link part:', encodedPart, e);
        return null;
    }

    const queryParams = new URLSearchParams(queryPart);
    let finalParams: Record<string, any> = {};
    for (const [key, value] of queryParams.entries()) {
        finalParams[key] = value;
    }

    // Strategy 1: Try to parse decoded data as JSON
    try {
        const config = JSON.parse(decodedData);
        // Standardize fields: some configs use 'server' and 'uuid' instead of 'add' and 'id'.
        if (!config.add && config.server) config.add = config.server;
        if (!config.id && config.uuid) config.id = config.uuid;

        if (config.add && config.port && config.id) {
            // Merge JSON config with URL query params, with query params taking precedence
            finalParams = { ...config, ...finalParams };
            
            const name = finalParams.ps || finalParams.remarks || finalParams.name || `${finalParams.add}:${finalParams.port}`;
            delete finalParams.ps;
            delete finalParams.remarks;
            // Also delete the 'name' field from the params if it exists, as it's now the top-level name.
            delete finalParams.name;

            return {
                name,
                link,
                protocol: 'vmess',
                protocol_params: finalParams,
                server: finalParams.add,
                port: Number(finalParams.port),
                type: 'vmess',
                password: finalParams.id,
                params: finalParams,
            };
        }
    } catch (e) {
        // Not a JSON, proceed to next strategy
    }

    // Strategy 2: Treat decoded data as a URL-like string (e.g., "auto:uuid@host:port")
    if (decodedData.includes('@')) {
        try {
            const atIndex = decodedData.lastIndexOf('@');
            const credentials = decodedData.substring(0, atIndex);
            const addressPart = decodedData.substring(atIndex + 1);

            const [method, uuid] = credentials.split(':');
            if (!uuid) throw new Error('Invalid VMess credentials in decoded data.');

            const portIndex = addressPart.lastIndexOf(':');
            if (portIndex === -1) throw new Error('Port not found in decoded data.');
            
            const server = addressPart.substring(0, portIndex);
            const port = Number(addressPart.substring(portIndex + 1));

            if (!server || !port) return null;

            // Base parameters from the decoded part
            let baseParams: Record<string, any> = {
                id: uuid,
                security: method,
                add: server,
                port: port,
            };

            // Merge with URL query params, query params take precedence
            finalParams = { ...baseParams, ...finalParams };

            const name = finalParams.remarks || finalParams.ps || server;
            // Clean up remarks/ps from final params if they exist
            delete finalParams.remarks;
            delete finalParams.ps;

            return {
                name,
                link,
                protocol: 'vmess',
                protocol_params: finalParams,
                server: finalParams.add,
                port: Number(finalParams.port),
                type: 'vmess',
                password: finalParams.id,
                params: finalParams,
            };
        } catch (error) {
            console.error('Failed to manually parse decoded VMess URL-like data:', decodedData, error);
            return null;
        }
    }

    console.error('Failed to parse VMess link. Decoded data was not valid JSON or a recognizable URL format:', decodedData);
    return null;
};

const parseHysteria2 = (link: string): ParsedNode | null => {
    if (!link.startsWith('hysteria2://')) return null;
    try {
        const url = new URL(link);
        const name = decodeURIComponent(url.hash.substring(1)) || url.hostname;
        const server = url.hostname;
        const port = Number(url.port);
        const auth = url.username; // Hy2 auth is in the username part

        if (!auth || !server || !port) return null;

        const protocol_params: Record<string, any> = {};
        for (const [key, value] of url.searchParams.entries()) {
            protocol_params[key] = value;
        }
        
        // Also add auth to params for completeness
        protocol_params.auth = auth;

        return {
            name,
            link,
            protocol: 'hysteria2',
            protocol_params,
            // Legacy fields
            server,
            port,
            type: 'hysteria2',
            password: auth,
            params: protocol_params,
        };
    } catch (error) {
        console.error('Failed to parse Hysteria2 link:', link, error);
        return null;
    }
};


const genericUrlParser = (link: string, protocol: 'ss' | 'trojan' | 'vless' | 'tuic'): ParsedNode | null => {
    if (!link.startsWith(`${protocol}://`)) return null;

    try {
        const url = new URL(link);
        const name = decodeURIComponent(url.hash.substring(1)) || url.searchParams.get('name') || url.hostname;
        const server = url.hostname;
        const port = Number(url.port);
        let password = url.username;
        let uuid = '';

        if (!server || !port) return null;

        const protocol_params: Record<string, any> = {};
        for (const [key, value] of url.searchParams.entries()) {
            protocol_params[key] = value;
        }

        if (protocol === 'ss') {
            // ss://<base64(method:pass)>@host:port#name
            try {
                const decodedUsername = decodeURIComponent(url.username);
                const decodedCredentials = base64Decode(decodedUsername);
                const [method, pass] = decodedCredentials.split(':');
                if (!method || !pass) return null;
                protocol_params.method = method;
                password = pass;
            } catch (e) {
                console.error('Failed to parse SS credentials', e);
                return null;
            }
        } else if (protocol === 'tuic') {
            // tuic://<uuid>:<password>@host:port?sni=...
            const credentials = url.username.split(':');
            uuid = credentials[0];
            password = credentials[1] || '';
            protocol_params.uuid = uuid;
        }
        
        if (!password && protocol !== 'ss') {
            // For vless and trojan, password/uuid is in username
            password = url.username;
            if (!password) return null;
        }
        if (protocol === 'tuic' && !uuid) return null;


        return {
            name,
            link,
            protocol,
            protocol_params,
            // Legacy fields
            server,
            port,
            type: protocol,
            password,
            params: protocol_params,
        };

    } catch (error) {
        console.error(`Failed to parse ${protocol} link:`, link, error);
        return null;
    }
}


export const parseNodeLinks = (linksText: string): (ParsedNode & { id: string; raw: string; })[] => {
  if (!linksText) {
    return [];
  }

  const links = linksText.split(/[\r\n]+/).map(link => link.trim()).filter(Boolean);
  const parsedNodes: (ParsedNode & { id: string; raw: string; })[] = [];

  for (const link of links) {
    let parsedNode: ParsedNode | null = null;

    if (link.startsWith('vmess://')) {
      parsedNode = parseVmess(link);
    } else if (link.startsWith('ss://')) {
      parsedNode = genericUrlParser(link, 'ss');
    } else if (link.startsWith('trojan://')) {
      parsedNode = genericUrlParser(link, 'trojan');
    } else if (link.startsWith('vless://')) {
      parsedNode = genericUrlParser(link, 'vless');
    } else if (link.startsWith('hysteria2://')) {
      parsedNode = parseHysteria2(link);
    } else if (link.startsWith('tuic://')) {
      parsedNode = genericUrlParser(link, 'tuic');
    }

    if (parsedNode) {
      // Assign a temporary client-side ID for UI keying purposes
      const nodeWithId = { ...parsedNode, id: uuidv4(), raw: link };
      parsedNodes.push(nodeWithId);
    }
  }

  return parsedNodes;
};

// A simple Base64 encoder that works in both browser and Node.js environments
const base64Encode = (str: string): string => {
    try {
        // For browser environments
        if (typeof btoa !== 'undefined') {
            return btoa(unescape(encodeURIComponent(str)));
        }
        // For Node.js environments
        if (typeof Buffer !== 'undefined') {
            return Buffer.from(str, 'utf-8').toString('base64');
        }
        return ''; // Fallback
    } catch (e) {
        console.error('Failed to encode to base64:', e);
        return '';
    }
};


export const regenerateLink = (node: ParsedNode): string => {
    const protocol = node.protocol;
    const name = encodeURIComponent(node.name);

    switch (protocol) {
        case 'vmess':
            const vmessConfig = { ...node.protocol_params, ps: node.name };
            return `vmess://${base64Encode(JSON.stringify(vmessConfig))}`;
        
        case 'ss':
            const credentials = `${node.protocol_params.method}:${node.password}`;
            const encodedCredentials = base64Encode(credentials).replace(/=/g, ''); // Some clients don't like padding
            return `ss://${encodedCredentials}@${node.server}:${node.port}#${name}`;

        case 'trojan':
        case 'vless':
            const trojanUrl = new URL(`${protocol}://${node.password}@${node.server}:${node.port}`);
            trojanUrl.hash = name;
            for (const key in node.protocol_params) {
                trojanUrl.searchParams.set(key, node.protocol_params[key]);
            }
            return trojanUrl.toString();

        case 'hysteria2':
            const hy2Url = new URL(`hysteria2://${node.password}@${node.server}:${node.port}`);
            hy2Url.hash = name;
            for (const key in node.protocol_params) {
                if (key !== 'auth') { // Auth is already in the userinfo part
                    hy2Url.searchParams.set(key, node.protocol_params[key]);
                }
            }
            return hy2Url.toString();
        
        case 'tuic':
            const tuicUrl = new URL(`tuic://${node.protocol_params.uuid}:${node.password}@${node.server}:${node.port}`);
            tuicUrl.hash = name;
            for (const key in node.protocol_params) {
                if (key !== 'uuid') {
                    tuicUrl.searchParams.set(key, node.protocol_params[key]);
                }
            }
            return tuicUrl.toString();

        default:
            return node.link || ''; // Fallback to original link
    }
};