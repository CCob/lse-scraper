
let cheerio = require('cheerio');
let chrono = require('chrono-node');
let Promise = require('bluebird');
let db = require('./db.js');
let posts = require('../../src/posts');
let toMarkdown = require('to-markdown');

const argv = require('minimist')(process.argv.slice(2));

let threadId = 14;
let maxPageCount = 50;
let delay = 10000;
let ignoreDuplicates = false;

function getContent (url) {
    // return new pending promise
    return new Promise((resolve, reject) => {
        // select http or https module, depending on reqested url
        const lib = url.startsWith('https') ? require('https') : require('http');
        const request = lib.get(url, (response) => {
            // handle http errors
            if (response.statusCode < 200 || response.statusCode > 299) {
                reject(new Error('Failed to load page, status code: ' + response.statusCode));
            }
            // temporary data holder
            const body = [];
            // on every content chunk, push it to the data array
            response.on('data', (chunk) => body.push(chunk));
            // we are done, resolve promise with those joined chunks
            response.on('end', () => resolve(body.join('')));
        });
        // handle connection errors of the request
        request.on('error', (err) => reject(err))
    })
}

let importPost = function(postInfo){
	let exists = Promise.promisify(db.exists);
	let setObjectField = Promise.promisify(db.setObjectField);
	let createPost = Promise.promisify(posts.create);
	const importedPostKey = `_imported_post:${postInfo.id}`;
	return exists(importedPostKey)
		.then( (result) => {
			if(result) {
				console.log(`No need to add post ${postInfo.id}, already exists`);
				return false;
			}
			else {
				return createPost({
					uid: 0,
					tid: threadId,
					content: `**${postInfo.subject}**\n\n${toMarkdown(postInfo.body)}`,
					timestamp: postInfo.date.getTime(),
					handle: postInfo.user,
				}).then((result) => {
					return setObjectField(importedPostKey, 'pid', result.pid);
				}).then((() => {
					return true;
				}))
			}
		})
};

let parsePage = function(pageContents){
    return new Promise(function(resolve, reject){
        let $ = cheerio.load(pageContents);
        let postInfos =  [];

        $('.FullChatPost[id]').each(function(idx, elem){

            let post = {};
            try {
            	referenceDate = new Date();
                post.id = parseInt(/chatPost_([0-9]*)/.exec($(elem).attr("id"))[1]);
                post.subject = $('.FullChatSubject',elem).text();
                post.body = $('.FullChatText',elem).html();
                post.user = $('.FullChatInfo',elem).children().first().text();
                post.date = chrono.parseDate($('.FullChatDate',elem).text(),referenceDate);
                if(post.date > referenceDate)
                	post.date.setDate(post.date.getDate() - 7)
                postInfos.push(post);
            }catch(error){
                reject(error);
            }
        })
        resolve(postInfos);
    });
};


if(argv.delay != null)
	delay = parseInt(argv.delay);

if(argv.thread != null)
	threadId = parseInt(argv.thread);

if(argv.pages != null)
	maxPageCount = parseInt(argv.pages);

if(argv.ignoreDuplicates != null)
	ignoreDuplicates = argv.ignoreDuplicates === 'true';


(function loop(i) {
    const url = `http://www.lse.co.uk/ShareChat.asp?page=${i}&ShareTicker=IRR`;
    new Promise((resolve, reject) => {
        console.log(`Fetching page ${i}`);
         getContent(url)
             .then(parsePage)
			 .map(importPost)
			 .then(function(result){
			 	resolve(result.indexOf(false) > -1);
			 })
             .catch(reject)
    }).then( (hadDuplicates) =>  {
        if(i < maxPageCount && (ignoreDuplicates || !hadDuplicates) ) {
			loop(i + 1)
		}
        else {
			console.log("Finished!");
			setTimeout(() => loop(1), delay * 1000);
		}
    } ).catch(function(error){
        console.log("Failed: " + error);
		setTimeout(() => loop(1), delay * 1000);
    });
})(1);


if(process.stdin.isTTY) {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on('data', process.exit.bind(process, 0));
}








