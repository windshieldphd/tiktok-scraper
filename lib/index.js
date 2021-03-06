'use strict';

const rp = require('request-promise');
const request = require('request');
const { jar } = require('request');
const archiver = require('archiver');
const fs = require('fs');
const { forEachLimit } = require('async');
const Json2csvParser = require('json2csv').Parser;
const ora = require('ora');
const Bluebird = require('bluebird');
const EventEmitter = require('events');

const CONST = require('./constant');
const MultipleBar = require('./multipleBar');
const generateSignature = require('./signature');

class TikTokScraper extends EventEmitter {
    constructor({
        download,
        filepath,
        filetype,
        proxy,
        asyncDownload,
        cli,
        event,
        timeout,
        progress,
        input,
        number,
        type,
        by_user_id = false,
        user_data = false,
    }) {
        super();
        this._mainHost = 'https://www.tiktok.com/';
        this._mHost = 'https://m.tiktok.com/';
        this._userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:73.0) Gecko/20100101 Firefox/73.0';
        this._download = download;
        this._filepath = '' || filepath;
        this._mbars = new MultipleBar();
        this._json2csvParser = new Json2csvParser();
        this._filetype = filetype;
        this._input = input;
        this._proxy = proxy;
        this._number = number;
        this._asyncDownload = asyncDownload || 5;
        this._collector = [];
        this._date = Date.now();
        this._cookieJar = jar();
        this._event = event;
        this._timeout = timeout;
        this._scrapeType = type;
        this._progress = true || progress;
        this._progressBar = [];
        this._cli = cli;
        this._spinner = cli ? ora('TikTok Scraper Started').start() : '';
        this._hasNextPage = false;
        this._by_user_id = by_user_id;
        this._user_data = user_data;
        this._rate_limit_count = 0;
        this._rate_limit = Date.now();
    }

    _addBar(len) {
        this._progressBar.push(
            this._mbars.newBar('Downloading :id [:bar] :percent', {
                complete: '=',
                incomplete: ' ',
                width: 30,
                total: len,
            }),
        );

        return this._progressBar[this._progressBar.length - 1];
    }

    toBuffer(item) {
        return new Promise((resolve, reject) => {
            let r = request;
            let barIndex;
            let buffer = Buffer.from('');
            if (this._proxy) {
                r = request.defaults({ proxy: `http://${this._proxy}/` });
            }
            r.get(item.videoUrl)
                .on('response', response => {
                    if (this._progress) {
                        barIndex = this._addBar(parseInt(response.headers['content-length']));
                    }
                })
                .on('data', chunk => {
                    buffer = Buffer.concat([buffer, chunk]);
                    if (this._progress) {
                        barIndex.tick(chunk.length, { id: item.id });
                    }
                })
                .on('end', () => {
                    resolve(buffer);
                })
                .on('error', () => {
                    reject(`Cant download media. If you were using proxy, please try without it.`);
                });
        });
    }

    zipIt() {
        return new Promise(async (resolve, reject) => {
            let zip = this._filepath ? `${this._filepath}/${this._scrapeType}_${this._date}.zip` : `${this._scrapeType}_${this._date}.zip`;
            let output = fs.createWriteStream(zip);
            let archive = archiver('zip', {
                gzip: true,
                zlib: { level: 9 },
            });
            archive.pipe(output);

            forEachLimit(
                this._collector,
                this._asyncDownload,
                (item, cb) => {
                    this.toBuffer(item)
                        .then(buffer => {
                            archive.append(buffer, { name: `${item.id}.mp4` });
                            cb(null);
                        })
                        .catch(error => {
                            cb(error);
                        });
                },
                error => {
                    if (error) {
                        return reject(error);
                    }

                    archive.finalize();
                    archive.on('end', () => resolve());
                },
            );
        });
    }

    _request({ uri, method, qs, body, form, headers, json, gzip }) {
        return new Promise(async (resolve, reject) => {
            let query = {
                uri,
                method,
                ...(qs ? { qs } : {}),
                ...(body ? { body } : {}),
                ...(form ? { form } : {}),
                headers: {
                    'User-Agent': this._userAgent,
                    ...headers,
                },
                ...(json ? { json: true } : {}),
                ...(gzip ? { gzip: true } : {}),
                jar: this._cookieJar,
                resolveWithFullResponse: true,
                ...(this._proxy ? { proxy: `https://${this._proxy}/` } : {}),
                timeout: 10000,
            };
            try {
                let response = await rp(query);

                if (this._timeout) {
                    setTimeout(() => {
                        resolve(response.body);
                    }, this._timeout);
                } else {
                    resolve(response.body, response.headers['content-type']);
                }
            } catch (error) {
                if (error.name === 'StatusCodeError') {
                    if (error.statusCode === 404) {
                        return reject({ message: 'Not found' });
                    }
                    reject(error.response.body);
                } else {
                    reject({ message: error.message ? error.message : 'Request error' });
                }
            }
        });
    }

    _collectUserProfileInformation() {
        let store = {};
        return new Promise((resolve, reject) => {
            if (this._rate_limit > Date.now()) {
                return resolve();
            }

            forEachLimit(
                this._collector,
                this._asyncDownload,
                (item, cb) => {
                    if (this._rate_limit > Date.now()) {
                        return cb(null);
                    }

                    if (store[item.authorName]) {
                        let { following, fans, heart, video, digg, verified } = store[item.authorName];
                        item.authorFollowing = following;
                        item.authorFans = fans;
                        item.authorHeart = heart;
                        item.authorVideo = video;
                        item.authorDigg = digg;
                        item.authorVerified = verified;
                        cb(null);
                    } else {
                        this._request({
                            method: 'GET',
                            uri: `https://www.tiktok.com/@${item.authorName}?`,
                            headers: {
                                'User-Agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_${Math.floor(
                                    Math.random() * (15 - 10) + 10,
                                )}_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.floor(
                                    Math.random() * (79 - 70) + 70,
                                )}.0.3945.117 Safari/537.36`,
                            },
                        })
                            .then(result => {
                                if (result === '{"statusCode":200,"contentType":"text/html","content":""}') {
                                    this._rate_limit_count++;
                                    if (this._rate_limit_count > 3) {
                                        this._rate_limit_count = 0;
                                        this._rate_limit = Date.now() + 60000 * 5;
                                    }
                                } else {
                                    if (result.indexOf('<script id="__NEXT_DATA__" type="application/json" crossorigin="anonymous">') > -1) {
                                        result = result
                                            .split('<script id="__NEXT_DATA__" type="application/json" crossorigin="anonymous">')[1]
                                            .split('</script><script crossorigin="anonymous" nomodule="" src="')[0];
                                        result = JSON.parse(result);
                                        store[item.authorName] = result.props.pageProps.userData;
                                        let { following, fans, heart, video, digg, verified } = store[item.authorName];
                                        item.authorFollowing = following;
                                        item.authorFans = fans;
                                        item.authorHeart = heart;
                                        item.authorVideo = video;
                                        item.authorDigg = digg;
                                        item.authorVerified = verified;
                                    }
                                }
                                cb(null);
                            })
                            .catch(error => {
                                cb(null);
                            });
                    }
                },
                error => {
                    resolve();
                },
            );
        });
    }
    _scrape() {
        return new Promise(async (resolve, reject) => {
            if (!this._scrapeType || CONST.scrape.indexOf(this._scrapeType) === -1) {
                return reject(`Missing scraping type. Scrape types: ${CONST.scrape} `);
            }
            if (this._scrapeType !== 'trend' && !this._input) {
                return reject('Missing input');
            }

            let maxCursor = 0;

            while (true) {
                if (this._number) {
                    if (this._collector.length >= this._number) {
                        break;
                    }
                }

                try {
                    switch (this._scrapeType) {
                        case 'hashtag':
                            var result = await this._scrapeData(await this._getHashTagId(), maxCursor);
                            break;
                        case 'user':
                            var result = await this._scrapeData(
                                this._by_user_id
                                    ? {
                                          id: this._input,
                                          secUid: '',
                                          type: 1,
                                          count: 48,
                                          minCursor: 0,
                                          lang: '',
                                      }
                                    : await this._getUserId(),
                                maxCursor,
                            );
                            break;
                        case 'trend':
                            var result = await this._scrapeData(
                                {
                                    id: '',
                                    secUid: '',
                                    shareUid: '',
                                    lang: '',
                                    type: 5,
                                    count: 30,
                                    minCursor: 0,
                                },
                                maxCursor,
                            );
                            break;
                        case 'music':
                            var result = await this._scrapeData(
                                {
                                    id: this._input,
                                    secUid: '',
                                    shareUid: '',
                                    lang: 'en',
                                    type: 4,
                                    count: 30,
                                    minCursor: 0,
                                },
                                maxCursor,
                            );
                            break;
                    }
                    await this._collectPosts(result.body.itemListData);

                    if (!result.body.hasMore) {
                        break;
                    } else {
                        maxCursor = result.body.maxCursor;
                    }
                } catch (error) {
                    if (this._event) {
                        return this.emit('error', error);
                    }
                    break;
                }
            }

            if (this._user_data) {
                await this._collectUserProfileInformation();
            }

            if (this._event) {
                return this.emit('done', 'completed');
            }

            if (!this._event) {
                try {
                    if (this._download) {
                        if (this._cli) {
                            this._spinner.stop();
                        }
                        await this.zipIt();
                    }

                    let json = this._filepath ? `${this._filepath}/${this._scrapeType}_${this._date}.json` : `${this._scrapeType}_${this._date}.json`;
                    let csv = this._filepath ? `${this._filepath}/${this._scrapeType}_${this._date}.csv` : `${this._scrapeType}_${this._date}.csv`;
                    let zip = this._filepath ? `${this._filepath}/${this._scrapeType}_${this._date}.zip` : `${this._scrapeType}_${this._date}.zip`;

                    if (this._collector.length) {
                        switch (this._filetype) {
                            case 'json':
                                await Bluebird.fromCallback(cb => fs.writeFile(json, JSON.stringify(this._collector), cb));
                                break;
                            case 'csv':
                                await Bluebird.fromCallback(cb => fs.writeFile(csv, this._json2csvParser.parse(this._collector), cb));
                                break;
                            case 'all':
                                await Promise.all([
                                    await Bluebird.fromCallback(cb => fs.writeFile(json, JSON.stringify(this._collector), cb)),
                                    await Bluebird.fromCallback(cb => fs.writeFile(csv, this._json2csvParser.parse(this._collector), cb)),
                                ]);
                                break;
                            default:
                                break;
                        }
                    }
                    if (this._cli) {
                        this._spinner.stop();
                    }

                    return resolve({
                        collector: this._collector,
                        ...(this._download ? { zip } : {}),
                        ...(this._filetype === 'all' ? { json, csv } : {}),
                        ...(this._filetype === 'json' ? { json } : {}),
                        ...(this._filetype === 'csv' ? { csv } : {}),
                    });
                } catch (error) {
                    reject(error);
                }
            }
        });
    }

    _collectPosts(posts) {
        return new Promise(async (resolve, reject) => {
            for (let i = 0; i < posts.length; i++) {
                if (this._number) {
                    if (this._collector.length >= this._number) {
                        break;
                    }
                }
                let item = {
                    id: posts[i].itemInfos.id,
                    text: posts[i].itemInfos.text,
                    createTime: posts[i].itemInfos.createTime,
                    authorId: posts[i].itemInfos.authorId,
                    authorName: posts[i].authorInfos.uniqueId,
                    authorFollowing: 0,
                    authorFans: 0,
                    authorHeart: 0,
                    authorVideo: 0,
                    authorDigg: 0,
                    authorVerified: '',
                    musicId: posts[i].itemInfos.musicId,
                    musicName: posts[i].musicInfos.musicName,
                    musicAuthor: posts[i].musicInfos.authorName,
                    musicOriginal: posts[i].musicInfos.original,
                    videoUrl: posts[i].itemInfos.video.urls[0],
                    diggCount: posts[i].itemInfos.diggCount,
                    shareCount: posts[i].itemInfos.shareCount,
                    playCount: posts[i].itemInfos.playCount,
                    commentCount: posts[i].itemInfos.commentCount,
                };

                if (this._event) {
                    this.emit('data', item);
                    this._collector.push('');
                } else {
                    this._collector.push(item);
                }
            }
            resolve();
        });
    }
    _scrapeData(qs, maxCursor) {
        return new Promise(async (resolve, reject) => {
            let shareUid = qs.type === 4 || qs.type === 5 ? '&shareUid=' : '';
            let _signature = generateSignature(
                `${this._mHost}share/item/list?secUid=${qs.secUid}&id=${qs.id}&type=${qs.type}&count=${qs.count}&minCursor=${
                    qs.minCursor
                }&maxCursor=${maxCursor || 0}${shareUid}&lang=${qs.lang}`,
                this._userAgent,
            );

            let query = {
                uri: `${this._mHost}share/item/list`,
                method: 'GET',
                qs: {
                    ...qs,
                    _signature,
                    maxCursor: 0 || maxCursor,
                },
                headers: {
                    accept: 'application/json, text/plain, */*',
                    referer: 'https://www.tiktok.com/',
                },
                json: true,
            };
            try {
                let body = await this._request(query);
                if (body.statusCode === 0) {
                    resolve(body);
                } else {
                    reject(body);
                }
            } catch (error) {
                reject(error);
            }
        });
    }

    // Start Get Id's
    _getIds({ uri, type }) {
        return new Promise(async (resolve, reject) => {
            let query = {
                uri,
                method: 'GET',
            };
            try {
                let body = await this._request(query);
                body = JSON.parse(body.split('<script id="__NEXT_DATA__" type="application/json" crossorigin="anonymous">')[1].split('</script>')[0]);
                if (type === 'user') {
                    if (body.props.pageProps.statusCode !== 0) {
                        return reject({ message: `Can't find anything` });
                    }
                    resolve({
                        id: body.props.pageProps.userData.userId,
                        secUid: '',
                        type: 1,
                        count: 48,
                        minCursor: 0,
                        lang: '',
                    });
                }
                if (type === 'hashtag') {
                    if (body.props.pageProps.statusCode !== 0) {
                        return reject({ message: `Can't find anything.` });
                    }

                    resolve({
                        id: body.props.pageProps.challengeData.challengeId,
                        secUid: '',
                        type: 3,
                        count: 48,
                        minCursor: 0,
                        lang: '',
                    });
                }
            } catch (error) {
                reject(error);
            }
        });
    }
    _getHashTagId() {
        return new Promise(async (resolve, reject) => {
            try {
                resolve(
                    this._getIds({
                        uri: `${this._mainHost}tag/${this._input}`,
                        type: 'hashtag',
                    }),
                );
            } catch (error) {
                reject(error);
            }
        });
    }
    _getUserId() {
        return new Promise(async (resolve, reject) => {
            try {
                resolve(
                    this._getIds({
                        uri: `${this._mainHost}@${this._input}`,
                        type: 'user',
                    }),
                );
            } catch (error) {
                reject(error);
            }
        });
    }
    // End Get ID's
}

module.exports = TikTokScraper;
