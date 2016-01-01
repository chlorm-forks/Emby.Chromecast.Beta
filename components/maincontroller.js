define(['datetime', 'embyactions', '//www.gstatic.com/cast/sdk/libs/receiver/2.0.0/cast_receiver.js', '//www.gstatic.com/cast/sdk/libs/mediaplayer/1.0.0/media_player.js', 'cryptojs-sha1'], function (datetime, embyActions) {

    window.mediaManager = new cast.receiver.MediaManager(window.mediaElement);
    setInterval(updateTimeOfDay, 40000);

    // According to cast docs this should be disabled when not needed
    //cast.receiver.logger.setLevelValue(cast.receiver.LoggerLevel.ERROR);

    var init = function () {

        resetPlaybackScope($scope);
        clearMediaElement();
    };

    init();

    embyActions.setApplicationClose();

    var mgr = window.mediaManager;

    var broadcastToServer = new Date();

    function onMediaElementTimeUpdate() {
        var now = new Date();

        var elapsed = now - broadcastToServer;

        if (elapsed > 5000) {

            embyActions.reportPlaybackProgress($scope, getReportingParams($scope));
            broadcastToServer = now;
        }
        else if (elapsed > 1500) {

            embyActions.reportPlaybackProgress($scope, getReportingParams($scope), false);
        }

        if (elapsed > 1000) {

            $scope.currentTime = window.mediaElement.currentTime;
        }
    }

    function onMediaElementPause() {
        embyActions.reportPlaybackProgress($scope, getReportingParams($scope));
    }

    function onMediaElementVolumeChange() {

        var volume = window.mediaElement.volume;
        window.VolumeInfo.Level = volume * 100;
        window.VolumeInfo.IsMuted = volume == 0;
    }

    function enableTimeUpdateListener(enabled) {
        if (enabled) {
            window.mediaElement.addEventListener('timeupdate', onMediaElementTimeUpdate);
            window.mediaElement.addEventListener('volumechange', onMediaElementVolumeChange);
            window.mediaElement.addEventListener('pause', onMediaElementPause);
        } else {
            window.mediaElement.removeEventListener('timeupdate', onMediaElementTimeUpdate);
            window.mediaElement.removeEventListener('volumechange', onMediaElementVolumeChange);
            window.mediaElement.removeEventListener('pause', onMediaElementPause);
        }
    }

    function isPlaying() {
        return window.playlist.length > 0;
    }

    window.addEventListener('beforeunload', function () {

        // Try to cleanup after ourselves before the page closes
        enableTimeUpdateListener(false);
        embyActions.reportPlaybackStopped($scope, getReportingParams($scope));
    });

    mgr.defaultOnPlay = mgr.onPlay;
    mgr.onPlay = function (event) {
        embyActions.play($scope, event);
        embyActions.reportPlaybackProgress($scope, getReportingParams($scope));
    };

    mgr.defaultOnPause = mgr.onPause;
    mgr.onPause = function (event) {
        mgr.defaultOnPause(event);
        embyActions.pause($scope);
        embyActions.reportPlaybackProgress($scope, getReportingParams($scope));
    };

    mgr.defaultOnStop = mgr.onStop;
    mgr.onStop = function (event) {
        stop();
    };

    mgr.onEnded = function () {

        embyActions.setApplicationClose();
        enableTimeUpdateListener(false);
        embyActions.reportPlaybackStopped($scope, getReportingParams($scope));
        init();

        if (!playNextItem()) {
            window.playlist = [];
            window.currentPlaylistIndex = -1;
            embyActions.displayUserInfo($scope, $scope.serverAddress, $scope.accessToken, $scope.userId);
        }
    };

    function stop(nextMode, callDefaultOnStop) {

        if (callDefaultOnStop !== false) {
            mgr.defaultOnStop(event);
        }

        embyActions.stop($scope);
        enableTimeUpdateListener(false);

        var reportingParams = getReportingParams($scope);

        var promise;

        embyActions.stopPingInterval();

        if (reportingParams.ItemId) {
            promise = embyActions.reportPlaybackStopped($scope, reportingParams);
        }

        clearMediaElement();

        if (promise) {
            return promise;
        }

        return new Promise(function (resolve, reject) {
            resolve();
        });
    }

    window.castReceiverManager = cast.receiver.CastReceiverManager.getInstance();

    window.castReceiverManager.onSystemVolumeChanged = function (event) {
        console.log("### Cast Receiver Manager - System Volume Changed : " + JSON.stringify(event));

        // See cast.receiver.media.Volume
        console.log("### Volume: " + event.data['level'] + " is muted? " + event.data['muted']);

        window.VolumeInfo.Level = (event.data['level'] || 1) * 100;
        window.VolumeInfo.IsMuted = event.data['muted'] || false;
    }

    console.log('Application is ready, starting system');

    // Create a custom namespace channel to receive commands from the sender
    // app to add items to a playlist
    window.playlistMessageBus = window.castReceiverManager.getCastMessageBus('urn:x-cast:com.connectsdk', cast.receiver.CastMessageBus.MessageType.JSON);

    function processMessage(data) {

        if (!data.command || !data.serverAddress || !data.userId || !data.accessToken) {

            console.log('Invalid message sent from sender. Sending error response');

            broadcastToMessageBus({
                type: 'error',
                message: "Missing one or more required params - command,options,userId,accessToken,serverAddress"
            });
            return;
        }

        data.options = data.options || {};
        window.deviceInfo.deviceName = data.receiverName || window.deviceInfo.deviceName;
        window.deviceInfo.deviceId = data.receiverName ? CryptoJS.SHA1(data.receiverName).toString() : window.deviceInfo.deviceId;
        window.playOptions.maxBitrate = Math.min(data.maxBitrate || window.playOptions.maxBitrate, BitrateCap);

        if (data.supportsAc3 != null) {
            window.playOptions.supportsAc3 = data.supportsAc3;
        }

        // Items will have properties - Id, Name, Type, MediaType, IsFolder

        var reportProgress = false;

        if (data.command == 'PlayLast' || data.command == 'PlayNext') {

            tagItems(data.options.items, data);
            queue(data.options.items, data.command);
        }
        else if (data.command == 'Shuffle') {
            shuffle(data, data.options, data.options.items[0]);
        }
        else if (data.command == 'InstantMix') {
            instantMix(data, data.options, data.options.items[0]);
        }
        else if (data.command == 'DisplayContent') {

            if (!isPlaying()) {

                console.log('DisplayContent');

                embyActions.displayItem($scope, data.serverAddress, data.accessToken, data.userId, data.options.ItemId);
            }

        }
        else if (data.command == 'NextTrack') {

            if (window.playlist && window.currentPlaylistIndex < window.playlist.length - 1) {
                stop("next");
            }

        }
        else if (data.command == 'PreviousTrack') {

            if (window.playlist && window.currentPlaylistIndex > 0) {
                stop("previous");
            }

        }
        else if (data.command == 'SetAudioStreamIndex') {

            // TODO

        }
        else if (data.command == 'SetSubtitleStreamIndex') {

            // TODO
            setSubtitleStreamIndex($scope, data.options.index, data.serverAddress);
        }
        else if (data.command == 'VolumeUp') {

            window.mediaElement.volume = Math.min(1, window.mediaElement.volume + .2);
            reportProgress = true;
        }
        else if (data.command == 'VolumeDown') {

            // TODO
            window.mediaElement.volume = Math.max(0, window.mediaElement.volume - .2);
            reportProgress = true;
        }
        else if (data.command == 'ToggleMute') {

            // TODO

        }
        else if (data.command == 'Identify') {

            if (!isPlaying()) {
                embyActions.displayUserInfo($scope, data.serverAddress, data.accessToken, data.userId);
            }
        }
        else if (data.command == 'SetVolume') {

            // Scale 0-100
            window.mediaElement.volume = data.options.volume / 100;
            reportProgress = true;
        }
        else if (data.command == 'Seek') {

            window.mediaElement.currentTime = data.options.position;
            reportProgress = true;
        }
        else if (data.command == 'Mute') {

            // TODO
            window.mediaElement.volume = 0;
        }
        else if (data.command == 'Stop') {

            stop();
        }
        else if (data.command == 'Pause') {

            window.mediaElement.pause();
            reportProgress = true;
        }
        else if (data.command == 'SetRepeatMode') {

            window.repeatMode = data.options.RepeatMode;

        }
        else if (data.command == 'Unpause') {

            window.mediaElement.play();
            reportProgress = true;
        }
        else {

            translateItems(data, data.options, data.options.items);
        }

        if (reportProgress) {
            embyActions.reportPlaybackProgress($scope, getReportingParams($scope));
        }
    }

    function setSubtitleStreamIndex($scope, index, serverAddress) {

        console.log('setSubtitleStreamIndex. index: ' + index);

        if (index == -1 || index == null) {
            $scope.subtitleStreamIndex = null;
            setTextTrack($scope);
            return;
        }

        JSON.stringify($scope.PlaybackMediaSource);
        var mediaStreams = $scope.PlaybackMediaSource.MediaStreams;

        var subtitleStream = getStreamByIndex(mediaStreams, 'Subtitle', index);

        if (!subtitleStream) {
            console.log('setSubtitleStreamIndex error condition - subtitle stream not found.');
            return;
        }

        console.log('setSubtitleStreamIndex DeliveryMethod:' + subtitleStream.DeliveryMethod);

        if (subtitleStream.DeliveryMethod == 'External') {

            var textStreamUrl = subtitleStream.IsExternalUrl ? subtitleStream.DeliveryUrl : (getUrl(serverAddress, subtitleStream.DeliveryUrl));

            console.log('Subtitle url: ' + textStreamUrl);
            setTextTrack($scope, textStreamUrl);
            $scope.subtitleStreamIndex = index;
            return;
        } else {
            console.log('setSubtitleStreamIndex video url change required');

        }
        // TODO: If we get here then it must require a transcoding change. 
    }

    // Create a message handler for the custome namespace channel
    window.playlistMessageBus.onMessage = function (event) {

        console.log('Playlist message: ' + JSON.stringify(event));

        var data = event.data;

        data.options = data.options || {};
        data.options.senderId = event.senderId;

        processMessage(data);
    };

    function tagItems(items, data) {

        // Attach server data to the items
        // Once day the items could be coming from multiple servers, each with their own security info
        for (var i = 0, length = items.length; i < length; i++) {

            items[i].userId = data.userId;
            items[i].accessToken = data.accessToken;
            items[i].serverAddress = data.serverAddress;
        }
    }

    function translateItems(data, options, items) {

        var callback = function (result) {

            options.items = result.Items;
            tagItems(options.items, data);
            playFromOptions(data.options);
        };

        translateRequestedItems(data.serverAddress, data.accessToken, data.userId, items).then(callback);
    }

    function instantMix(data, options, item) {

        getInstantMixItems(data.serverAddress, data.accessToken, data.userId, item).then(function (result) {

            options.items = result.Items;
            tagItems(options.items, data);
            playFromOptions(data.options);
        });
    }

    function shuffle(data, options, item) {

        getShuffleItems(data.serverAddress, data.accessToken, data.userId, item).then(function (result) {

            options.items = result.Items;
            tagItems(options.items, data);
            playFromOptions(data.options);
        });
    }

    function queue(items, method) {
        window.playlist.push(items);
    }

    function playFromOptions(options) {

        var firstItem = options.items[0];

        if (options.startPositionTicks || firstItem.MediaType !== 'Video') {
            playFromOptionsInternal(options);
            return;
        }

        getIntros(firstItem.serverAddress, firstItem.accessToken, firstItem.userId, firstItem).then(function (intros) {

            tagItems(intros.Items, {
                userId: firstItem.userId,
                accessToken: firstItem.accessToken,
                serverAddress: firstItem.serverAddress
            });

            options.items = intros.Items.concat(options.items);
            playFromOptionsInternal(options);
        });
    }

    function playFromOptionsInternal(options) {

        var stopPlayer = window.playlist && window.playlist.length > 0;

        window.playlist = options.items;
        window.currentPlaylistIndex = -1;
        playNextItem(options, stopPlayer);
    }

    // Plays the next item in the list
    function playNextItem(options, stopPlayer) {

        var playlist = window.playlist;

        if (!playlist) {
            return false;
        }

        var newIndex;

        switch (window.repeatMode) {

            case 'RepeatOne':
                newIndex = window.currentPlaylistIndex;
                break;
            case 'RepeatAll':
                newIndex = window.currentPlaylistIndex + 1;
                if (newIndex >= window.playlist.length) {
                    newIndex = 0;
                }
                break;
            default:
                newIndex = window.currentPlaylistIndex + 1;
                break;
        }

        if (newIndex < playlist.length) {
            window.currentPlaylistIndex = newIndex;

            var item = playlist[window.currentPlaylistIndex];

            playItem(item, options || {}, stopPlayer);
            return true;
        }
        return false;
    }

    function playPreviousItem(options) {

        var playlist = window.playlist;

        if (playlist && window.currentPlaylistIndex > 0) {
            window.currentPlaylistIndex--;

            var item = playlist[window.currentPlaylistIndex];

            playItem(item, options || {}, false);
            return true;
        }
        return false;
    }

    function playItem(item, options, stopPlayer) {

        var callback = function () {
            onStopPlayerBeforePlaybackDone(item, options);
        };

        if (stopPlayer) {

            stop("none", false).then(callback);
        }
        else {
            callback();
        }
    }

    function onStopPlayerBeforePlaybackDone(item, options) {

        var requestUrl = getUrl(item.serverAddress, 'Users/' + item.userId + '/Items/' + item.Id);

        return fetchhelper.ajax({

            url: requestUrl,
            headers: getSecurityHeaders(item.accessToken, item.userId),
            dataType: 'json',
            type: 'GET'

        }).then(function (data) {

            // Attach the custom properties we created like userId, serverAddress, itemId, etc
            angular.extend(data, item);

            playItemInternal(data, options);

        }, broadcastConnectionErrorMessage);
    }

    function playItemInternal(item, options) {

        setAppStatus('loading');

        unloadPlayer();

        var deviceProfile = getDeviceProfile();
        var maxBitrate = window.playOptions.maxBitrate;

        embyActions.getPlaybackInfo(item, maxBitrate, deviceProfile, options.startPositionTicks, options.mediaSourceId, options.audioStreamIndex, options.subtitleStreamIndex).then(function (result) {

            if (validatePlaybackInfoResult(result)) {

                var mediaSource = getOptimalMediaSource(item.MediaType, result.MediaSources);

                if (mediaSource) {

                    if (mediaSource.RequiresOpening) {

                        embyActions.getLiveStream(item, result.PlaySessionId, maxBitrate, deviceProfile, options.startPositionTicks, mediaSource, null, null).then(function (openLiveStreamResult) {

                            openLiveStreamResult.MediaSource.enableDirectPlay = supportsDirectPlay(openLiveStreamResult.MediaSource);
                            playMediaSource(result.PlaySessionId, item, mediaSource, options);
                        });

                    } else {
                        playMediaSource(result.PlaySessionId, item, mediaSource, options);
                    }
                } else {
                    showPlaybackInfoErrorMessage('NoCompatibleStream');
                }
            }

        }, broadcastConnectionErrorMessage);

    }

    function validatePlaybackInfoResult(result) {

        if (result.ErrorCode) {

            showPlaybackInfoErrorMessage(result.ErrorCode);
            return false;
        }

        return true;
    }

    function showPlaybackInfoErrorMessage(errorCode) {

        broadcastToMessageBus({
            type: 'playbackerror',
            message: errorCode
        });
    }

    function getOptimalMediaSource(mediaType, versions) {

        var optimalVersion = versions.filter(function (v) {

            v.enableDirectPlay = supportsDirectPlay(v);

            return v.enableDirectPlay;

        })[0];

        if (!optimalVersion) {
            optimalVersion = versions.filter(function (v) {

                return v.SupportsDirectStream;

            })[0];
        }

        return optimalVersion || versions.filter(function (s) {
            return s.SupportsTranscoding;
        })[0];
    }

    function supportsDirectPlay(mediaSource) {

        if (mediaSource.SupportsDirectPlay && mediaSource.Protocol == 'Http' && !mediaSource.RequiredHttpHeaders.length) {

            // TODO: Need to verify the host is going to be reachable
            return true;
        }

        return false;
    }

    function setTextTrack($scope, subtitleStreamUrl) {

        while (window.mediaElement.firstChild) {
            window.mediaElement.removeChild(window.mediaElement.firstChild);
        }
        var track;
        if (window.mediaElement.textTracks.length == 0) {
            window.mediaElement.addTextTrack("subtitles");
        }
        track = window.mediaElement.textTracks[0];
        var cues = track.cues;
        for (var i = cues.length - 1 ; i >= 0 ; i--) {
            track.removeCue(cues[i]);
        }
        if (subtitleStreamUrl) {
            embyActions.getSubtitle($scope, subtitleStreamUrl).then(function (data) {

                track.mode = "showing";

                data.TrackEvents.forEach(function (trackEvent) {
                    track.addCue(new VTTCue(trackEvent.StartPositionTicks / 10000000, trackEvent.EndPositionTicks / 10000000, trackEvent.Text.replace(/\\N/gi, '\n')));
                });
            });
        }
    }

    function playMediaSource(playSessionId, item, mediaSource, options) {

        setAppStatus('loading');

        unloadPlayer();

        var streamInfo = createStreamInfo(item, mediaSource, options.startPositionTicks);

        var url = streamInfo.url;
        setTextTrack($scope, streamInfo.subtitleStreamUrl);

        var mediaInfo = {
            customData: {
                startPositionTicks: options.startPositionTicks || 0,
                serverAddress: item.serverAddress,
                userId: item.userId,
                itemId: item.Id,
                mediaSourceId: streamInfo.mediaSource.Id,
                audioStreamIndex: streamInfo.audioStreamIndex,
                subtitleStreamIndex: streamInfo.subtitleStreamIndex,
                playMethod: streamInfo.isStatic ? 'DirectStream' : 'Transcode',
                runtimeTicks: streamInfo.mediaSource.RunTimeTicks,
                liveStreamId: streamInfo.mediaSource.LiveStreamId,
                accessToken: item.accessToken,
                canSeek: streamInfo.canSeek,
                canClientSeek: streamInfo.canClientSeek,
                playSessionId: playSessionId
            },
            metadata: {},
            contentId: url,
            contentType: streamInfo.contentType,
            tracks: undefined,
            streamType: cast.receiver.media.StreamType.BUFFERED
        };

        if (streamInfo.mediaSource.RunTimeTicks) {
            mediaInfo.duration = Math.floor(streamInfo.mediaSource.RunTimeTicks / 10000000);
        }

        embyActions.load($scope, mediaInfo.customData, item);
        $scope.PlaybackMediaSource = mediaSource;

        var autoplay = true;

        mediaElement.autoplay = autoplay;

        // Create the Host - much of your interaction with the library uses the Host and
        // methods you provide to it.
        var host = new cast.player.api.Host({ 'mediaElement': window.mediaElement, 'url': url });

        // TODO: Add info from startPositionTicks
        var startSeconds = options.startPositionTicks && streamInfo.canClientSeek ? (Math.floor(options.startPositionTicks / 10000000)) : 0;

        console.log('Video start position seconds: ' + startSeconds);

        var protocol = null;

        if (url.lastIndexOf('.m3u8') >= 0) {
            // HTTP Live Streaming
            protocol = cast.player.api.CreateHlsStreamingProtocol(host);
        } else if (url.lastIndexOf('.mpd') >= 0) {
            // MPEG-DASH
            protocol = cast.player.api.CreateDashStreamingProtocol(host);
        } else if (url.indexOf('.ism/') >= 0) {
            // Smooth Streaming
            protocol = cast.player.api.CreateSmoothStreamingProtocol(host);
        }

        host.onError = function (errorCode) {

            host.onError = null;

            console.log("Fatal Error - " + errorCode);

            broadcastToMessageBus({
                type: 'error',
                message: "Fatal Error - " + errorCode
            });

            stop(null, false);
        };

        if (protocol !== null) {

            console.log("Starting Media Player Library");
            window.player = new cast.player.api.Player(host);
            window.player.load(protocol, startSeconds);

            if (streamInfo.playerStartPositionTicks) {
                window.mediaElement.currentTime = (streamInfo.playerStartPositionTicks / 10000000);
            }
            if (autoplay) {
                window.mediaElement.pause();
                embyActions.delayStart($scope);
            }

        } else {

            var seekParam = startSeconds ? '#t=' + (startSeconds) : '';
            window.mediaElement.src = url + seekParam;
            window.mediaElement.autoplay = true;

            window.mediaElement.load();
            if (autoplay) {
                window.mediaElement.pause();
                embyActions.delayStart($scope);
            }
        }

        enableTimeUpdateListener(false);
        enableTimeUpdateListener(true);

        setMetadata(item, mediaInfo.metadata, datetime);

        // We use false as we do not want to broadcast the new status yet
        // we will broadcast manually when the media has been loaded, this
        // is to be sure the duration has been updated in the media element
        window.mediaManager.setMediaInformation(mediaInfo, false);
    }

    window.castReceiverManager.start();
});