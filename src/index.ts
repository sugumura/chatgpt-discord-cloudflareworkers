import { Context, Hono } from "hono";
import { Configuration, CreateImageRequest, OpenAIApi } from "openai";
import { verifyKey } from 'discord-interactions'
import fetchAdapter from "@vespaiach/axios-fetch-adapter";

type Bindings = {
  DISCORD_MESSAGES: Queue;
  OPENAI_API_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", async (c) => {
  return c.text("Hello Cloudflare workers");
});

app.post("/api/generate", async (c: Context) => {
  const { prompt } = await c.req.json();
  const res = await createDogImage(c.env.OPENAI_API_KEY, prompt);
  return c.json({ ...res.data.data });
});

// discordから呼び出し
app.post("/discord/interactions", async (c: Context) => {
  const timestamp = c.req.header('X-Signature-Timestamp');
  const signature = c.req.header('X-Signature-Ed25519');
  if (timestamp === undefined || signature === undefined) {
    console.error("invalid request signature header none")
    return new Response('invalid request signature', { status: 401 });
  }
  
  const arrayBuffer = await c.req.arrayBuffer();
  const body = JSON.parse(new TextDecoder().decode(arrayBuffer))

  const isVerified = verifyKey(
    arrayBuffer,
    signature,
    timestamp,    
    c.env.DISCORD_PUBLIC_KEY,
  )

  if (!isVerified) {
    console.error("invalid request signature")
    return new Response('invalid request signature', { status: 401 });
  }

  console.log(JSON.stringify(body))

  // PONGを返す
  if (body.type === 1) {
    console.log("return PONE")
    return c.json({
      type: 1,
    })  
  }
  if (body.type === 2) {
    const prompt = body.data.options[0].value
    console.log("in APPLICATION_COMMAND")
    if (body.data.name === 'gendog') {
      // queueに送信
      const res = await c.env.DISCORD_MESSAGES.send(body);
      return c.json({
        type: 4,
        data: {
          content: `生成中(gendoc): "${prompt}"`
        }
      });
    }
  
    if (body.data.name === 'gencat') {
      // queueに送信
      const res = await c.env.DISCORD_MESSAGES.send(body);
      return c.json({
        type: 4,
        data: {
          content: `生成中(gencat): "${prompt}"`
        }
      });
    }
  }
  return c.json({}, 400)
})

app.get("/discord/command", async (c: Context) => {
  const applicationId = c.env.DISCORD_APPLICATION_ID;
  const token = c.env.DISCORD_TOKEN;
  const url = `https://discord.com/api/v10/applications/${applicationId}/commands`;
  await registerCommands(token, url);
  return c.json({ status: "ok" });
});

async function registerCommands(token: string, url: string) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${token}`,
    },
    method: "PUT",
    body: JSON.stringify([
      {
        name: "gendog",
        description: "犬を生成",
        options: [{
          type: 3,  // string
          name: "prompt",
          description: "生成コマンド",
          required: true,
        }]
      },
      {
        name: "gencat",
        description: "猫を生成",
        options: [{
          type: 3,  // string
          name: "prompt",
          description: "生成コマンド",
          required: true,
        }]
      },
    ]),
  });

  if (response.ok) {
    console.log("Registered all commands");
  } else {
    console.error("Error registering commands");
    const text = await response.text();
    console.error(text);
  }
  return response;
}

/**
 * 画像作成
 * @param c
 * @returns
 */
const createDogImage = async (key: string, prompt: string) => {
  const configuration = new Configuration({
    apiKey: key,
    baseOptions: {
      adapter: fetchAdapter,
    },
  });

  const openai = new OpenAIApi(configuration);
  const params: CreateImageRequest = {
    prompt: String(prompt),
    n: 1,
    size: "512x512",
  };
  const res = await openai.createImage(params);

  return res;
};

type QueueMessage = {
  body: {
    application_id: string,
    channel: {
      guild_id: string
      last_message_id: string
    },
    channel_id: string
    data: {
      id: string
      name: "gencat" | "gendog"
      options: [{
        name: "prompt"
        type: 3
        value: string
      }]
      type: 1
    },
    token: string,
  }
}

const postFollowup = async (token: string, params: any) => {  
  const url  = `https://discord.com/api/v10/webhooks/${params.application_id}/${params.token}`
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${token}`,
    },
    method: "POST",
    body: JSON.stringify({
      content: params.url,
      message_reference: {
        channel_id: params.channel_id,
        guild_id: params.guild_id,
        message_id: params.message_id,
      }
    }),    
  });

  if (response.ok) {
    console.log("postMessage ok");
  } else {
    console.error("Error postMessage");
    const text = await response.text();
    console.error(text);
  }
  return response;
}


const postMessage = async (token: string, params: any) => {  
  const url  = `https://discord.com/api/v10/channels/${params.channel_id}/messages`
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${token}`,
    },
    method: "POST",
    body: JSON.stringify({
      content: params.url,
      message_reference: {
        channel_id: params.channel_id,
        guild_id: params.guild_id,
        message_id: params.message_id,
      }
    }),    
  });

  if (response.ok) {
    console.log("postMessage ok");
  } else {
    console.error("Error postMessage");
    const text = await response.text();
    console.error(text);
  }
  return response;
}

const getBodyParams = (body: any) => {
  return {
    token: body.token,
    application_id: body.application_id,
    channel_id: body.channel_id,
    guild_id: body.channel.guild_id,
    message_id: body.channel.last_message_id
  }
}

/**
 * Queueの実行
 * @param batch 
 * @param env 
 */
const queue = async (batch: MessageBatch<Error>, env: Bindings): Promise<void> => {
  const messages = JSON.stringify(batch.messages);
  const queueMessages = JSON.parse(messages) as QueueMessage[];

  if (queueMessages.length > 0) {
    const body = queueMessages[0].body
    const prompt = body.data.options[0].value
  
    // ChatGPTに画像生成
    const res = await createDogImage(env.OPENAI_API_KEY, prompt)
    const parmas = {
      prompt,
      url: res.data.data[0].url,
      ...getBodyParams(body),
    }
    // Discordに投稿
    const resMessage = await postFollowup(env.DISCORD_TOKEN, parmas)
  }
}

export default {
  fetch: app.fetch,
  queue,
};
