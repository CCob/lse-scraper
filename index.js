'use strict';

let cheerio = require('cheerio');
let chrono = require('chrono-node');
let Promise = require('bluebird');
let db = require('./db.js');
let posts = require('../../src/posts');
let topics = require('../../src/topics')
let batch = require('../../src/batch');
let toMarkdown = require('to-markdown');
let winston = require('../../node_modules/winston');
let async = require('async');

const argv = require('minimist')(process.argv.slice(2));

let threadId = 14;
let maxPageCount = 50;
let delay = 10000;
let ignoreDuplicates = false;
let deletePostsBeforeImport = false;

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
	let getObjectField = Promise.promisify(db.getObjectField);
	let setObjectField = Promise.promisify(db.setObjectField);
	let createPost = Promise.promisify(posts.create);
	let dbDelete = Promise.promisify(db.delete);
	const importedPostKey = `_imported_post:${postInfo.id}`;
	let postId = null;

	return getObjectField(importedPostKey, 'pid')
		.then( (result) => {
			if (result != null) {
				postId = result;
				return getObjectField(`post:${postId}`, '_imported_post');
			}else{
				return Promise.resolve(0);
			}
		})
		.then( (importedPostId) => {
			if(importedPostId == null) {
				winston.warn(`Removing orphaned imported_post ${importedPostId}`);
				return dbDelete(importedPostKey);
			}else if(importedPostId > 0)
				return Promise.reject(`Imported post with id ${importedPostId} already exists`);
			else
				return;
		})
		.then(() => {

			let pid = null;
			return createPost({
				uid: 0,
				tid: threadId,
				content: `**${postInfo.subject}**\n\n${toMarkdown(postInfo.body)}`,
				timestamp: postInfo.date.getTime(),
				handle: postInfo.user,
			}).then((result) => {
				pid = result.pid;
				return setObjectField(importedPostKey, 'pid', result.pid);
			}).then(() => {
				return setObjectField(`post:${pid}`, '_imported_post', postInfo.id);
			}).then((() => {
				return true;
			}))
		}, (reason) => {
			winston.debug(reason);
		})
};

let parsePage = function(pageContents){
    return new Promise(function(resolve, reject){
        let $ = cheerio.load(pageContents);
        let postInfos =  [];

        $('.FullChatPost[id]').each(function(idx, elem){

            let post = {};
            try {
            	let referenceDate = new Date();
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

function deletePostsIfNeeded(){

	if(deletePostsBeforeImport) {
		let processSortedSet = Promise.promisify(batch.processSortedSet, {multiArgs: true});

		return processSortedSet('tid:' + threadId + ':posts', function (pids, next) {
			async.eachLimit(pids, 10, function (pid, next) {
				posts.purge(pid, 0, next);
				winston.debug(`Deleting post with id ${pid}`);
			});
		}, {alwaysStartAt: 0})
			.then(winston.info('Finished cleanup of topics posts'));
	}else{
		return new Promise((resolve,reject) =>{
			winston.debug(`Not deleting topic posts`);
			resolve();
		})
	}
}

function importNewPosts(i){
	const url = `http://www.lse.co.uk/ShareChat.asp?page=${i}&ShareTicker=IRR`;
	new Promise((resolve, reject) => {
		winston.debug(`Fetching page ${i} from ${url}`);
		getContent(url)
			.then(parsePage)
			.map(importPost)
			.then(function(result){
				const totalAdded = result.reduce( (total,added) => {return (added ? ++total : total)}, 0);
				winston.info(`Added ${totalAdded} posts from page ${i}`);
				resolve(totalAdded);
			})
			.catch(reject)
	}).then( (totalAdded) =>  {
		if(i < maxPageCount && (ignoreDuplicates || totalAdded > 0) ) {
			importNewPosts(i + 1)
		}
		else {
			winston.debug(`Finished page ${i}!`);
			setTimeout(() => importNewPosts(1), delay * 1000);
		}
	} ).catch(function(error){
		winston.error("Failed: " + error);
		setTimeout(() => importNewPosts(1), delay * 1000);
	});

}

if(argv.delay != null)
	delay = parseInt(argv.delay);

if(argv.thread != null)
	threadId = parseInt(argv.thread);

if(argv.pages != null)
	maxPageCount = parseInt(argv.pages);

if(argv.ignoreDuplicates != null)
	ignoreDuplicates = argv.ignoreDuplicates === 'true';

if(argv.deletePostsBeforeImport != null)
	deletePostsBeforeImport = argv.deletePostsBeforeImport === 'true';

winston.info(`Starting LSE Scraper - delay:${delay} thread:${threadId} pages:${maxPageCount} ignoreDuplicates:${ignoreDuplicates} deletePostsBeforeImport:${deletePostsBeforeImport}`);

deletePostsIfNeeded()
	.then(importNewPosts(1))

if(process.stdin.isTTY) {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on('data', process.exit.bind(process, 0));
}








