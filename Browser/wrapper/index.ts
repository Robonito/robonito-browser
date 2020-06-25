import { IPlaywrightServer, PlaywrightService } from './generated/playwright_grpc_pb';
import { chromium, firefox, webkit, Browser, BrowserContext, Page } from 'playwright';
import {sendUnaryData, ServerUnaryCall, Server, ServerCredentials, ServiceError, status} from "grpc";
import {openBrowserRequest, Empty, Response, goToRequest, inputTextRequest, selectorRequest, screenshotRequest, getDomPropertyRequest, SelectEntry, selectOptionRequest} from "./generated/playwright_pb";

// This is necessary for improved typescript inference
/* 
 * If obj is not trueish call callback with new Error containing message
 */
function exists<T1, T2>(obj: T1, callback: sendUnaryData<T2>, message: string): asserts obj is NonNullable<T1> {
    if (!obj) {
        callback(new PwserverError(message, status.FAILED_PRECONDITION), null)
    }
}

class PwserverError extends Error implements ServiceError {
    code: number
    constructor(details: string, code: number) {
        super(details)
        this.code = code
    }
}

// Can't have an async constructor, this is a workaround
async function createBrowserState(browserType: string): Promise<BrowserState> {
    const headless = true
    let browser, context, page
    if (browserType === 'firefox') {
        browser = await firefox.launch({headless: headless})
    } else if (browserType === 'chrome') {
        browser = await chromium.launch({headless: headless})
    } else if (browserType === 'webkit'){
        browser = await webkit.launch()
    } else {
        throw new Error("unsupported browser")
    }
    context = await browser.newContext()
    page = await context.newPage()
    return new BrowserState(browser, context, page)
}


class BrowserState {
    constructor(browser: Browser, context: BrowserContext, page: Page) {
        this.browser = browser
        this.context = context
        this.page = page
    }
    browser: Browser
    context: BrowserContext
    page: Page
}

function emptyWithLog(text: string): Response.Empty {
    const response = new Response.Empty()
    response.setLog(text)
    return response
}

class PlaywrightServer implements IPlaywrightServer {
    private browserState?: BrowserState
    // current open browsers main context and open page

    private async openUrlInPage(url: string, page: Page): Promise<string> {
        console.log('Go to url' + url)
        await page.goto(url)

        return "Succesfully opened URL " + url
    }

    async closeBrowser(call: ServerUnaryCall<Empty>, callback: sendUnaryData<Response.Empty>): Promise<void> {
        exists(this.browserState, callback, "Tried to close browser but none was open")

        await this.browserState.browser.close()
        this.browserState = undefined
        console.log("Closed browser")
        const response = emptyWithLog('Closed browser')
        callback(null, response)
    }

    async openBrowser(call: ServerUnaryCall<openBrowserRequest>, callback: sendUnaryData<Response.Empty>): Promise<void> {
        const browserType = call.request.getBrowser()
        const url = call.request.getUrl()
        console.log("Open browser: " + browserType)
        // TODO: accept a flag for headlessness
        this.browserState = await createBrowserState(browserType)
        const response = new Response.Empty()
        if (url) {
           const returnValue = await this.openUrlInPage(url, this.browserState?.page)
           response.setLog(returnValue);
        }
        console.log('Browser opened')
        callback(null, response);
    }

    async goTo(call: ServerUnaryCall<goToRequest>, callback: sendUnaryData<Response.Empty>): Promise<void> {
        const url = call.request.getUrl()
        console.log("Go to URL: " + url)
        exists(this.browserState, callback, "Tried to open URl but had no browser open")
        await this.browserState.page.goto(url)
        const response = emptyWithLog("Succesfully opened URL")
        callback(null, response)
    }

    async getTitle(call: ServerUnaryCall<Empty>, callback: sendUnaryData<Response.String>): Promise<void> {
        exists(this.browserState, callback, "Tried to get title, no open browser")
        console.log('Getting title')
        const title = await this.browserState.page.title()
        const response = new Response.String()
        response.setBody(title)
        callback(null, response)
    }

    async getUrl(call: ServerUnaryCall<Empty>, callback: sendUnaryData<Response.String>): Promise<void> {
        exists(this.browserState, callback, "Tried to get page URL, no open browser")
        console.log('Getting URL')
        const url = this.browserState.page.url()
        const response = new Response.String()
        response.setBody(url)
        callback(null, response)
        
    }
    
    async getTextContent(call: ServerUnaryCall<selectorRequest>, callback: sendUnaryData<Response.String>): Promise<void> {
        exists(this.browserState, callback, "Tried to find text on page, no open browser")
        const selector = call.request.getSelector()
        const content = await this.browserState.page.textContent(selector)
        const response = new Response.String()
        response.setBody(content?.toString() || "")
        callback(null, response)
    }

    // TODO: work some of getDomProperty and getBoolProperty's duplicate code into a root function
    async getDomProperty(call: ServerUnaryCall<getDomPropertyRequest>, callback: sendUnaryData<Response.String>): Promise<void> {
        exists(this.browserState, callback, "Tried to get DOM property, no open browser")
        const selector = call.request.getSelector()
        const property = call.request.getProperty()
        
        const element = await this.browserState.page.$(selector)
        exists(element, callback, "Couldn't find element: " + selector)
        
        const result = await element.getProperty(property)
        const content = await result.jsonValue()
        console.log(`Retrieved dom property for element ${selector} containing ${content}`)

        const response = new Response.String()
        response.setBody(content)
        callback(null, response)
    }

    async getBoolProperty(call: ServerUnaryCall<getDomPropertyRequest>, callback: sendUnaryData<Response.Bool>): Promise<void> {
        exists(this.browserState, callback, "Tried to get DOM property, no open browser")
        const selector = call.request.getSelector()
        const property = call.request.getProperty()
        
        const element = await this.browserState.page.$(selector)
        exists(element, callback, "Couldn't find element: " + selector)
        
        const result = await element.getProperty(property)
        const content = await result.jsonValue()
        console.log(`Retrieved dom property for element ${selector} containing ${content}`)

        const response = new Response.Bool()
        response.setBody(content || false)
        callback(null, response)
    }

    async getSelectContent(call: ServerUnaryCall<selectorRequest>, callback: sendUnaryData<Response.Select>): Promise<void> {
        exists(this.browserState, callback, "Tried to get Select element contents, no open browser")
        const selector = call.request.getSelector()
        const page = this.browserState.page

        const content = await page.$$eval(selector + " option", elements => elements.map(element => { 
            //@ts-ignore
            return [element.label, element.value, "" != element.selected]
        }))
        
        const response = new Response.Select()
        content.forEach((option) => {
            const [label, value, selected] = option
            const entry = new SelectEntry()
            entry.setLabel(label)
            entry.setValue(value)
            entry.setSelected(selected)
            response.addEntry(entry)
        })
        callback(null, response)
    }
    
    async inputText(call: ServerUnaryCall<inputTextRequest>, callback: sendUnaryData<Response.Empty>): Promise<void> {
        exists(this.browserState, callback, "Tried to input text, no open browser")
        const inputText = call.request.getInput()
        const selector = call.request.getSelector()
        await this.browserState.page.fill(selector, inputText)
        
        const response = emptyWithLog("Input text: " + inputText)
        callback(null, response)
    }
    
    async clickButton(call: ServerUnaryCall<selectorRequest>, callback: sendUnaryData<Response.Empty>): Promise<void> {
        exists(this.browserState, callback, "Tried to click button, no open browser")

        const selector = call.request.getSelector()
        await this.browserState.page.click(selector)
        const response = emptyWithLog("Clicked button: " + selector)
        callback(null, response)
    }

    async checkCheckbox(call: ServerUnaryCall<selectorRequest>, callback: sendUnaryData<Response.Empty>): Promise<void> {
        exists(this.browserState, callback, "Tried to check checkbox, no open browser")
        const selector = call.request.getSelector()
        await this.browserState.page.check(selector)
        const response = emptyWithLog("Checked checkbox: " + selector)
        callback(null, response)
    } 
    async uncheckCheckbox(call: ServerUnaryCall<selectorRequest>, callback: sendUnaryData<Response.Empty>): Promise<void> {
        exists(this.browserState, callback, "Tried to uncheck checkbox, no open browser")
        const selector = call.request.getSelector()
        await this.browserState.page.uncheck(selector)
        const response = emptyWithLog("Unhecked checkbox: " + selector)
        callback(null, response)
    }

    async selectOption(call: ServerUnaryCall<selectOptionRequest>, callback: sendUnaryData<Response.Empty>): Promise<void> {
        exists(this.browserState, callback, "Tried to select ``select`` element option, no open browser")
        const selector = call.request.getSelector()
        const matcher = call.request.getMatcherList()
        console.log(`Selecting from element ${selector} options ${matcher}`)
        const result = await this.browserState.page.selectOption(selector, matcher)
        if  (result.length == 0) {
            console.log("Couldn't select any options")
            const error = new PwserverError(`No options matched ${matcher}`, status.NOT_FOUND)
            callback(error, null)
        }
        const response = emptyWithLog(`Selected options ${result} in element ${selector}`)
        callback(null, response)
    }

    async health(call: ServerUnaryCall<Empty>, callback: sendUnaryData<Response.String>): Promise<void> {
        const response = new Response.String()
        response.setBody("OK")
        callback(null, response)
    }

    async screenshot(call: ServerUnaryCall<screenshotRequest>, callback: sendUnaryData<Response.Empty>): Promise<void> {
        exists(this.browserState, callback, "Tried to take screenshot, no open browser")
        // Add the file extension here because the image type is defined by playwrights defaults
        const path = call.request.getPath() + ".png" 
        console.log(`Taking a screenshot of current page to ${path}`)
        await this.browserState.page.screenshot({path: path})

        const response = emptyWithLog("Succesfully took screenshot")
        callback(null, response)
    }
}

const server = new Server();
server.addService<IPlaywrightServer>(PlaywrightService, new PlaywrightServer());
const port = process.env.PORT || '0'
server.bind(`localhost:${port}`, ServerCredentials.createInsecure());
console.log(`Listening on ${port}`);
server.start();
