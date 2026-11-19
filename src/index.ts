import "reflect-metadata"
import * as fs from 'fs'
import { inspect } from 'util'

/**
 * Used to put all decorator logs from this class into a sub directory. This will however use the default log path, not the one that can be set with Logger.configure 
 * @param {string | undefined} directory Name of the sub directory. If not specified, it will use the name of the class
 */
export function Logged(directory?: string) {
    return <T extends Type<Object>>(constructor: T) => {
        directory ??= constructor.name

        const logger = new Logger({
            instanceBased: true,
            localPath: directory
        })
        
        Reflect.defineMetadata("logger", logger, constructor)
    }
}

interface Type<T> extends Function {
    new(...args: any[]): T
}

/**
 * Logs all method parameters, return value, and errors
 * @param {string[]} propertyNames if specified, any object parameter will omit all other properties from the log except the ones specified
 */
export function Log(...propertyNames: string[] | [string[]]) {
    return function (target: any, key: string, descriptor: PropertyDescriptor) {
        let original = descriptor.value
        const targetClass = typeof target === "function" ? target : target.constructor
        const source = `${target.name ?? target.constructor.name}.${key}`

        descriptor.value = function (...args: any[]) {
            const logger: Logger = Reflect.getOwnMetadata("logger", targetClass) || Logger
            
            const entry = logger.createEntry(source)

            const propertyKeys = propertyNames.flat()

            if (propertyKeys.length > 0) {
                const filteredArgs = args.map(a => filterObject(a, propertyKeys))

                logger.writeToEntry(entry, "arguements", filteredArgs)
                // logger.log(filteredArgs, `(${source}) [${callId}] arguements`)
            } else {
                logger.writeToEntry(entry, "arguements", args)
                // logger.log(args, `(${source}) [${callId}] arguements`)
            }

            try {
                const start = performance.now()

                const result = original.apply(this, args)

                Promise.resolve(result).then((r: any) => {
                    const end = performance.now()
                    // if(logger.timer) logger.log(end - start, `(${source}) [${callId}] Elapsed time (ms)`)
                    if(logger.timer) logger.writeToEntry(entry, "timer", end - start)

                    // logger.log(r, `(${source}) [${callId}] return`)
                    logger.writeToEntry(entry, "return", r)
                }).catch(error => {
                    // logger.log(error.message, `(${source}) [${callId}] error message`)
                    logger.writeToEntry(entry, "error", error)
                    throw error
                })

                return result
            } catch (error: any) {
                // logger.log(error.message, `(${source}) [${callId}] error message`)
                logger.writeToEntry(entry, "error", error)

                throw error
            }
        }
    }
}

function filterObject(obj: Record<string, any>, propertyKeys: string[]) {
    if (typeof obj != "object") return obj
    return propertyKeys.reduce((r, k) => {
        const [key, ...rest] = k.split(".")
        const nested = rest.join(".")
        if (nested) {
            r[key] = {
                ...r[key],
                ...filterObject(obj[key], [nested])
            }
        } else {
            r[key] = obj[key]
        }

        return r
    }, <Record<string, any>>{})
}

export class Logger {
    static get defaultLogPath() {
        return 'log'
    }

    private static instance = new Logger()

    private instanceBased = false
    private _logPath = Logger.defaultLogPath
    private _timer = false
    private _compact = true
    private _outputFormat: config["outputFormat"] = "json"
    private _defaultLogging = true
    private _outputHandler: config["outputHandler"]

    private entryIdCounter = 0
    private entires: logEntry[] = []

    get logPath(): string {
        if(this.instanceBased) return `${Logger.instance.logPath}${this._logPath.substring(1)}`
        return this._logPath
    }

    get timer(): boolean {
        return this._timer || this.instanceBased && Logger.instance.timer
    }

    get compact(): boolean {
        return this.instanceBased ? Logger.instance.compact : this._compact
    }

    get outputFormat(): config["outputFormat"] {
        return this.instanceBased ? Logger.instance.outputFormat : this._outputFormat
    }

    get defaultLogging(): boolean {
        return this.instanceBased ? Logger.instance.defaultLogging : this._defaultLogging
    }

    get outputHandler(): config["outputHandler"] {
        return this.instanceBased ? Logger.instance.outputHandler : this._outputHandler
    }

    constructor(config?: Partial<config>) {
        
        if(!config) return
        if (config.localPath) this._logPath = `./${config.localPath}`
        if (config.instanceBased) this.instanceBased = config.instanceBased
        if (config.timer != undefined) this._timer = config.timer
        if (config.compact != undefined) this._compact = config.compact
        if (config.outputFormat != undefined) this._outputFormat = config.outputFormat
        if (config.defaultLogging != undefined) this._defaultLogging = config.defaultLogging
        this._outputHandler = config.outputHandler
    }

    static configure(config: Partial<config>) {
        this.instance = new Logger({ ...config, instanceBased: false })
    }

    /**
     * Logs the stringified version of an object
     * @param {Object} obj the object
     * @param {string | undefined} pretext text that shows before the obj, to describe it
     */
    static log(obj: Object, pretext?: string) {
        this.instance.log(obj, pretext)
    }

    /**
     * Logs the stringified version of an object
     * @param {Object} obj the object
     * @param {string | undefined} pretext text that shows before the obj, to describe it
     */
    log(obj: any, pretext?: string) {
        // const json = inspect(obj, { depth: Infinity, compact: this.compact })
        const json = this.stringify(obj)

        if (pretext) {
            this.writeLine(`${pretext}: ${json}`)
            return
        }

        this.writeLine(json)
    }

    createEntry(source: string) {
        const id = this.entryIdCounter++

        const entry: logEntry = { id, source }
        this.entires.push(entry)
        return entry
    }

    writeToEntry<K extends keyof logEntry>(entry: logEntry | number, type: K, data: any) {
        if(typeof entry == "number") {
            const foundEntry = this.entires.find(e => e.id == entry)
            if(!foundEntry) throw new Error("Non-existing entry id")
            entry = foundEntry
        }

        entry[type] = data
        
        if(this.defaultLogging) {
            if(type == "error") data = data.message
            this.log(data, `(${entry.source}) [${entry.id}] ${this.getEntryLabel(type)}`)
        }

        if(["return", "error"].includes(type)) {
            if(this.outputHandler) this.outputHandler(entry)
            const i = this.entires.indexOf(entry)
            this.entires.splice(i, 1)
        }
    }

    private getEntryLabel(type: keyof logEntry) {
        const lib: Partial<Record<keyof logEntry, string>> = {
            "timer": "Elapsed time (ms)",
            "error": "error message"
        }

        return lib[type] ?? type
    }

    private stringify(obj: any) {
        if(this.outputFormat == "inspect") {
            return inspect(obj, { depth: Infinity, compact: this.compact })
        }

        const set = new WeakSet()

        return JSON.stringify(obj, (key, value) => {
            if(typeof value === "object" && value !== null) {
                if(set.has(value)) return "[Circular]"
                set.add(value)
            }

            return value
        }, this.compact ? undefined : 4)
    }

    private writeLine(line: string) {
        const dateTime = this.dateTime

        if (!fs.existsSync(this.logPath)) {
            fs.mkdirSync(this.logPath, { recursive: true })
        }

        fs.appendFileSync(`${this.logPath}/${this.date}.txt`, `[${dateTime}] ${line}\n`)
    }

    private get date() {
        const date = new Date()
        return this.padSingleDigit([
            date.getFullYear(),
            date.getMonth() + 1,
            date.getDate()
        ]).join("-")
    }

    private get time() {
        const date = new Date()
        return this.padSingleDigit([
            date.getHours(),
            date.getMinutes(),
            date.getSeconds()
        ]).join(":")
    }

    private padSingleDigit(arr: number[]) {
        return arr.map(n => {
            if (n > 9) return n.toString()
            return `0${n}`
        })
    }

    private get dateTime() {
        return `${this.date} ${this.time}`
    }
}

export type config = {
    instanceBased: boolean //if set to true. behavior of your logger object will be relative the static logger. default: false
    localPath: string //path within it will make files. default: "log"
    timer: boolean //time method calls. default: false
    compact: boolean //compacts json objects when logged. default: true
    outputFormat: "json" | "inspect" //whether the output should render in pure json or use inspect. default: "json"
    defaultLogging: boolean //if set to false, it will no longer log to files specified in localPath. default: true
    outputHandler?: (entry: logEntry) => void //if set, it will call this function when a logged method returns or throws an error 
}

export type logEntry = {
    id: number
    source: string
    arguements?: any[]
    return?: any
    timer?: number
    error?: any
}