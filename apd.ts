import { open } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { lookup } from "mime-types";
import { type HTMLElement, parse } from "node-html-parser";
import { type Cookie, parse as parseCookie } from "set-cookie-parser";

const PAHE_WIN_URL_REGEX = /^https?:\/\/pahe\.win\/[a-z0-9]+/i;
const VM_CONTEXT = createContext({ decodedString: "" });

interface DestructedURL {
  protocol: string;
  hostname: string;
  pathname: string;
  search: string;
  hash: string;
}

const destructureUrl = (url: string): DestructedURL | null => {
  try {
    const _url = new URL(url);
    return {
      protocol: _url.protocol,
      hostname: _url.hostname,
      pathname: _url.pathname,
      search: _url.search,
      hash: _url.hash,
    };
  } catch {
    return null;
  }
};

const getDOM = async (url: string, cookies?: Cookie[]) => {
  const responseText = await fetch(url).then((res) => {
    if (cookies) {
      const parsedCookies = parseCookie(res.headers.get("set-cookie") || "");
      cookies.push(...parsedCookies);
    }
    return res.text();
  });
  const root = parse(responseText);
  return root;
};

const getKwikDownloadPageLink = (root: HTMLElement) => {
  const script = root.querySelector("script[type='text/javascript']:not([src])");
  if (!script) return null;

  const link = script.textContent?.match(/(https?:\/\/kwik\.si\/f\/[a-z0-9]+)/i);
  return link ? `${link[1]}` : null;
};

const downloadFromPaheWin = async (url: string) => {
  const durl = destructureUrl(url);
  const cookies: Cookie[] = [];
  if (!(durl && PAHE_WIN_URL_REGEX.test(url))) {
    throw new Error("Invalid URL");
  }

  console.log("Getting page content from:", url);
  const pwDOM = await getDOM(url)
    .then((dom) => {
      console.log("Page content fetched successfully.");
      return dom;
    })
    .catch(() => console.error("Failed to fetch page content."));
  if (!pwDOM) return null;

  console.log();
  console.log("Searching for Kwik download link...");
  const kwikLink = getKwikDownloadPageLink(pwDOM);
  if (kwikLink) {
    console.log("Kwik download link found:", kwikLink);
  } else {
    console.error("Kwik download link not found.");
    return null;
  }

  console.log();
  console.log("Fetching Kwik download page...");
  const htmlRoot = await getDOM(kwikLink, cookies);

  console.log();
  console.log("Sniffing around for a specific script...");
  const tokenScript = Array.from(htmlRoot.querySelectorAll("body > script")).find((el) =>
    el.innerHTML.includes(`0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/`),
  );
  if (tokenScript) {
    console.log("I spy, with my little eye, a script with a token!");
  } else {
    console.error("Token script not found. We may need better hounds to sniff this out.");
    return null;
  }

  console.log();
  console.log("Running the script in a VM context to decode the token...");
  console.log("This is safe... probably.");
  runInContext(tokenScript.innerHTML.replace("eval", "decodedString="), VM_CONTEXT);
  const decodedString: string = String(VM_CONTEXT.decodedString);
  const downloadForm = decodedString.match(/<form.*>.*<\/form>/)?.[0];
  if (!downloadForm) {
    console.error("We couldn't decode this one boys. We'll get 'em next time.");
    return null;
  }

  console.log();
  console.log("Please wait. Acquiring some boring data...");
  const formElement = parse(downloadForm).querySelector("form");
  if (!(formElement && formElement.tagName.toLowerCase() === "form")) {
    console.error("We looked but failed to see.");
    return null;
  }

  const formAction = formElement.getAttribute("action") || kwikLink;
  const formElements = Array.from(formElement.querySelectorAll("input, select, textarea"));
  const formData = new FormData();

  for (const element of formElements) {
    const name = element.getAttribute("name");
    const value = element.getAttribute("value") || "";
    name && formData.append(name, value);
  }

  console.log();
  console.log("Remember that data we mentioned? We're sending it now...");

  console.log("Sending zeros and ones to:", formAction);
  const response = await fetch(formAction, {
    method: "POST",
    body: formData,
    headers: {
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      referer: kwikLink,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0",
    },
  });

  if (!response.ok) {
    console.error("The zeros and ones didn't work. The server is not happy.");
    console.error(response.status, response.statusText);
    return null;
  }

  const filename =
    response.headers.get("content-disposition")?.match(/filename="(.+?)"/)?.[1] ||
    response.url.split("?file=")[1] ||
    `AnimePaheDownloader ${crypto.randomUUID().split("-").slice(0, 2).join("")}.file`;
  const filetype = lookup(filename) || "application/octet-stream";
  const fileSize = response.headers.get("content-length") || -1;

  console.log();
  console.log("Zeros and ones accepted. Meeting is over, here's the TL;DR.");
  console.log("-".repeat(process.stdout.columns / 2));
  console.log("Name:", filename);
  console.log("Type:", filetype);
  console.log(
    "Size:",
    fileSize === -1 ? "<take a guess>" : `${(+fileSize / 1024 / 1024).toFixed(2)} MB`,
  );

  console.log();
  const reader = await response.body?.getReader();
  const writeStream = await open(filename, "w")
    .then((fileHandle) => fileHandle.createWriteStream())
    .catch(() => {
      console.error("Failed to open file for writing. Please check permissions or path.");
      return null;
    });
  if (!writeStream) return null;
  if (!reader) {
    console.error("Failed to get response body reader.");
    return null;
  }

  console.log("Saving file to:", filename);
  let bytesWritten = 0;
  let writeStreamClosed = false;
  const write = async () => {
    if (writeStreamClosed) return;

    const { done, value } = await reader.read();
    if (done) {
      writeStream.end();
      writeStream.removeAllListeners("drain");
      console.log("File saved successfully.");
      return;
    }

    const shouldContinue = writeStream.write(value);
    bytesWritten += value.length;
    console.log(`Written ${bytesWritten} bytes so far...`);
    if (shouldContinue) await write();
  };

  writeStream.on("drain", write);
  writeStream.on("error", (err) => {
    console.error("Error writing to file:", err);
    writeStream.close();
    writeStreamClosed = true;
  });
  await write();

  return response;
};

await downloadFromPaheWin("https://pahe.win/QnSgV"); //.then(console.log).catch(console.error);
