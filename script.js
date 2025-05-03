// Dark mode functionality
function initDarkMode() {
	const darkModeToggle = document.getElementById("darkModeToggle");
	const prefersDarkScheme = window.matchMedia("(prefers-color-scheme: dark)");

	// Check for saved theme preference or use system preference
	const savedTheme = localStorage.getItem("theme");
	if (savedTheme) {
		document.documentElement.setAttribute("data-theme", savedTheme);
	} else if (prefersDarkScheme.matches) {
		document.documentElement.setAttribute("data-theme", "dark");
	}

	// Toggle dark mode
	darkModeToggle.addEventListener("click", () => {
		const currentTheme = document.documentElement.getAttribute("data-theme");
		const newTheme = currentTheme === "dark" ? "light" : "dark";

		document.documentElement.setAttribute("data-theme", newTheme);
		localStorage.setItem("theme", newTheme);
	});
}

// Configuration
const ANOMALY_THRESHOLDS = {
	FALL_VELOCITY: -0.25,
	FALL_DURATION: 500,
	FALL_CONFIRMATION_FRAMES: 5,
	FIGHT_DISTANCE: 100,
};

const DETECTION_CONFIG = {
	MIN_CONFIDENCE: 0.4,
	MAX_OBJECTS: 15,
	MIN_SCORE: 0.4,
	IOU_THRESHOLD: 0.45,
};

// Add these constants at the top of the file
const CAMERA_SOURCES = {
	WEBCAM: "webcam",
	DROIDCAM: "droidcam",
};

// DOM Elements
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const alertBox = document.getElementById("alert");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDiv = document.getElementById("status");

// State
let poseDetector;
let objectDetector;
let lastPose;
let lastTimestamp;
let fallStartTime = null;
let fallFrames = 0;
let lastAlertTime = 0;
let isDetecting = false;
let detectionLoop = null;
let isVideoReady = false;
let currentCameraSource = CAMERA_SOURCES.WEBCAM;
let ipWebcamUrl = "";

// Initialize
async function init() {
	try {
		// Initialize dark mode
		initDarkMode();

		// Load models first
		console.log("Loading pose detection model...");
		const model = poseDetection.SupportedModels.MoveNet;
		poseDetector = await poseDetection.createDetector(model, {
			modelType: "SinglePose.Lightning",
			enableSmoothing: true,
			minPoseScore: 0.3,
		});
		console.log("Pose detection model loaded");

		console.log("Loading object detection model...");
		objectDetector = await cocoSsd.load({ base: "lite_mobilenet_v2" });
		console.log("Object detection model loaded");

		// Setup button event listeners
		startBtn.addEventListener("click", startCamera);
		stopBtn.addEventListener("click", stopCamera);

		updateStatus("Ready to start");
	} catch (error) {
		console.error("Initialization error:", error);
		updateStatus("Error initializing models: " + error.message, true);
		// Show more detailed error in console
		console.error("Full error details:", error);
	}
}

// Add this function to handle URL validation and conversion
function validateAndConvertUrl(url) {
	try {
		// Remove any whitespace
		url = url.trim();

		// If URL doesn't start with http:// or https://, add http://
		if (!url.startsWith("http://") && !url.startsWith("https://")) {
			url = "http://" + url;
		}

		// Create URL object to validate
		const urlObj = new URL(url);

		// Always use HTTP for IP Webcam
		urlObj.protocol = "http:";

		// Validate port number
		if (!urlObj.port) {
			urlObj.port = "8080"; // Default IP Webcam port
		}

		// Ensure path ends with /video
		if (!urlObj.pathname.endsWith("/video")) {
			urlObj.pathname = "/video";
		}

		return urlObj.toString();
	} catch (error) {
		console.error("Invalid URL:", error);
		throw new Error(
			"Invalid URL format. Please use format: http://[ip-address]:[port]/video"
		);
	}
}

// Update the setIpWebcamUrl function
function setIpWebcamUrl(url) {
	try {
		ipWebcamUrl = validateAndConvertUrl(url);
		updateStatus("IP Webcam URL set: " + ipWebcamUrl);
	} catch (error) {
		updateStatus("Error setting IP Webcam URL: " + error.message, true);
	}
}

// Add this function to test the IP Webcam connection
async function testIpWebcamConnection(url) {
	try {
		const response = await fetch(url, {
			method: "HEAD",
			mode: "no-cors", // This prevents CORS issues
		});
		return true;
	} catch (error) {
		console.error("IP Webcam connection test failed:", error);
		return false;
	}
}

// Add this function to check camera permissions
async function checkCameraPermissions() {
	try {
		const result = await navigator.permissions.query({ name: "camera" });
		console.log("Camera permission state:", result.state);
		return result.state;
	} catch (error) {
		console.error("Error checking camera permissions:", error);
		return "unknown";
	}
}

// Update the listAvailableCameras function
async function listAvailableCameras() {
	try {
		// First check permissions
		const permissionState = await checkCameraPermissions();
		console.log("Camera permission state:", permissionState);

		if (permissionState === "denied") {
			throw new Error(
				"Camera access is denied. Please allow camera access in your browser settings."
			);
		}

		// Request camera access to trigger permission prompt if needed
		const tempStream = await navigator.mediaDevices.getUserMedia({
			video: true,
		});
		tempStream.getTracks().forEach((track) => track.stop()); // Stop the temporary stream

		// Now enumerate devices
		const devices = await navigator.mediaDevices.enumerateDevices();
		const videoDevices = devices.filter(
			(device) => device.kind === "videoinput"
		);

		console.log(
			"All devices:",
			devices.map((d) => ({ kind: d.kind, label: d.label }))
		);
		console.log(
			"Video devices:",
			videoDevices.map((d) => ({ id: d.deviceId, label: d.label }))
		);

		return videoDevices;
	} catch (error) {
		console.error("Error listing cameras:", error);
		if (error.name === "NotAllowedError") {
			throw new Error(
				"Camera access is denied. Please allow camera access in your browser settings."
			);
		}
		throw error;
	}
}

// Add this function to get camera selection
async function getCameraSelection() {
	const videoDevices = await listAvailableCameras();
	if (videoDevices.length === 0) {
		throw new Error("No cameras found");
	}

	// Create a more detailed list of cameras
	const cameraList = videoDevices.map((device, index) => {
		const label = device.label || `Camera ${index + 1}`;
		const lowerLabel = label.toLowerCase();

		// More specific DroidCam detection
		const isDroidCam =
			lowerLabel.includes("droidcam") ||
			(lowerLabel.includes("android") && !lowerLabel.includes("usb")) ||
			lowerLabel.includes("virtual camera") ||
			lowerLabel.includes("droidcam virtual");

		return {
			id: device.deviceId,
			label: label,
			isDroidCam: isDroidCam,
			isUSB: lowerLabel.includes("usb"),
			isVirtual: lowerLabel.includes("virtual"),
		};
	});

	console.log("Available cameras:", cameraList);

	// Try to find DroidCam
	const droidcamDevice = cameraList.find(
		(camera) => camera.isDroidCam && !camera.isUSB
	);

	if (droidcamDevice) {
		console.log("Found DroidCam:", droidcamDevice);
		return droidcamDevice;
	}

	// If no DroidCam found, show all cameras and let user select
	const cameraSelect = document.createElement("select");
	cameraSelect.id = "cameraSelect";
	cameraSelect.style.width = "100%";
	cameraSelect.style.marginBottom = "10px";
	cameraSelect.style.padding = "8px";

	// Group cameras by type
	const usbCameras = cameraList.filter((camera) => camera.isUSB);
	const virtualCameras = cameraList.filter(
		(camera) => camera.isVirtual && !camera.isUSB
	);
	const otherCameras = cameraList.filter(
		(camera) => !camera.isUSB && !camera.isVirtual
	);

	// Add USB cameras group
	if (usbCameras.length > 0) {
		const usbGroup = document.createElement("optgroup");
		usbGroup.label = "USB Cameras";
		usbCameras.forEach((camera) => {
			const option = document.createElement("option");
			option.value = camera.id;
			option.text = camera.label;
			usbGroup.appendChild(option);
		});
		cameraSelect.appendChild(usbGroup);
	}

	// Add Virtual cameras group
	if (virtualCameras.length > 0) {
		const virtualGroup = document.createElement("optgroup");
		virtualGroup.label = "Virtual Cameras (DroidCam)";
		virtualCameras.forEach((camera) => {
			const option = document.createElement("option");
			option.value = camera.id;
			option.text = camera.label;
			virtualGroup.appendChild(option);
		});
		cameraSelect.appendChild(virtualGroup);
	}

	// Add Other cameras group
	if (otherCameras.length > 0) {
		const otherGroup = document.createElement("optgroup");
		otherGroup.label = "Other Cameras";
		otherCameras.forEach((camera) => {
			const option = document.createElement("option");
			option.value = camera.id;
			option.text = camera.label;
			otherGroup.appendChild(option);
		});
		cameraSelect.appendChild(otherGroup);
	}

	// Create a container for the select element
	const container = document.createElement("div");
	container.style.margin = "10px 0";
	container.innerHTML = "<label>Select Camera:</label>";
	container.appendChild(cameraSelect);

	// Add it to the DroidCam settings
	const droidcamSettings = document.getElementById("droidcamSettings");
	const existingSelect = document.getElementById("cameraSelect");
	if (existingSelect) {
		existingSelect.remove();
	}
	droidcamSettings.appendChild(container);

	// Return the selected camera
	return new Promise((resolve) => {
		cameraSelect.onchange = () => {
			const selectedCamera = cameraList.find(
				(camera) => camera.id === cameraSelect.value
			);
			resolve(selectedCamera);
		};
		// Trigger initial selection
		cameraSelect.onchange();
	});
}

// Update the startCamera function
async function startCamera() {
	try {
		// Reset state
		isDetecting = false;
		isVideoReady = false;
		if (detectionLoop) {
			cancelAnimationFrame(detectionLoop);
			detectionLoop = null;
		}

		// Setup video element
		video.width = 640;
		video.height = 480;
		canvas.width = 640;
		canvas.height = 480;

		let stream;

		switch (currentCameraSource) {
			case CAMERA_SOURCES.DROIDCAM:
				try {
					updateStatus("Checking camera permissions...");
					const permissionState = await checkCameraPermissions();
					if (permissionState === "denied") {
						throw new Error(
							"Camera access is denied. Please allow camera access in your browser settings."
						);
					}

					updateStatus("Looking for cameras...");
					const selectedCamera = await getCameraSelection();

					if (!selectedCamera) {
						throw new Error("No camera selected");
					}

					updateStatus(`Connecting to ${selectedCamera.label}...`);
					// Try to get stream with specific device
					stream = await navigator.mediaDevices.getUserMedia({
						video: {
							deviceId: { exact: selectedCamera.id },
							width: { ideal: 640 },
							height: { ideal: 480 },
							frameRate: { ideal: 30 },
						},
					});

					if (!stream) {
						throw new Error("Failed to get video stream");
					}

					video.srcObject = stream;
					console.log(
						"Successfully connected to camera:",
						selectedCamera.label
					);
				} catch (error) {
					console.error("Camera connection error:", error);
					throw new Error(
						`Camera connection failed: ${error.message}. Please make sure DroidCam is running and connected.`
					);
				}
				break;

			default:
				// Local webcam
				try {
					stream = await navigator.mediaDevices.getUserMedia({
						video: {
							width: { ideal: 640 },
							height: { ideal: 480 },
							frameRate: { ideal: 30 },
						},
					});
					video.srcObject = stream;
				} catch (error) {
					throw new Error("Failed to access local webcam: " + error.message);
				}
		}

		// Wait for video to be ready
		await new Promise((resolve, reject) => {
			video.onloadedmetadata = () => {
				video
					.play()
					.then(() => {
						isVideoReady = true;
						resolve();
					})
					.catch(reject);
			};
			video.onerror = (error) =>
				reject(new Error("Video error: " + error.message));
		});

		// Update UI
		startBtn.disabled = true;
		stopBtn.disabled = false;
		updateStatus("Camera is running");
		alertBox.style.display = "none";

		// Start detection
		isDetecting = true;
		detectPosesAndObjects();
	} catch (error) {
		console.error("Camera start error:", error);
		updateStatus("Error starting camera: " + error.message, true);
		// Cleanup on error
		if (video.srcObject) {
			const tracks = video.srcObject.getTracks();
			tracks.forEach((track) => track.stop());
			video.srcObject = null;
		}
		isVideoReady = false;
		isDetecting = false;
	}
}

function stopCamera() {
	// Stop the video stream
	if (video.srcObject) {
		const tracks = video.srcObject.getTracks();
		tracks.forEach((track) => track.stop());
		video.srcObject = null;
	} else if (video.src) {
		video.src = "";
	}

	// Stop detection
	isDetecting = false;
	isVideoReady = false;
	if (detectionLoop) {
		cancelAnimationFrame(detectionLoop);
		detectionLoop = null;
	}

	// Clear canvas
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	// Update UI
	startBtn.disabled = false;
	stopBtn.disabled = true;
	updateStatus("Camera is stopped");
	alertBox.style.display = "none";
}

function updateStatus(message, isError = false) {
	statusDiv.textContent = message;
	statusDiv.style.backgroundColor = isError ? "#ffebee" : "#e8f5e9";
	statusDiv.style.color = isError ? "#d32f2f" : "#2e7d32";
}

// Main detection loop
async function detectPosesAndObjects() {
	if (!isDetecting || !isVideoReady) {
		console.log("Detection stopped or video not ready");
		return;
	}

	try {
		// Check video state
		if (!video.srcObject || !video.videoWidth || !video.videoHeight) {
			console.log("Waiting for video to be ready...");
			detectionLoop = requestAnimationFrame(detectPosesAndObjects);
			return;
		}

		// Ensure video is playing
		if (video.paused) {
			try {
				await video.play();
			} catch (playError) {
				console.error("Error playing video:", playError);
				return;
			}
		}

		// Perform detection
		let poses = [];
		let objects = [];

		try {
			const poseResults = await poseDetector.estimatePoses(video, {
				maxPoses: 5,
				flipHorizontal: true,
			});

			// Validate pose results
			if (poseResults && Array.isArray(poseResults)) {
				poses = poseResults.filter(
					(pose) =>
						pose &&
						pose.keypoints &&
						Array.isArray(pose.keypoints) &&
						pose.keypoints.length > 0
				);
			}

			const objectResults = await objectDetector.detect(
				video,
				DETECTION_CONFIG.MAX_OBJECTS,
				DETECTION_CONFIG.MIN_SCORE
			);

			// Validate object results
			if (objectResults && Array.isArray(objectResults)) {
				objects = objectResults;
			}
		} catch (detectionError) {
			console.error("Error during detection:", detectionError);
			detectionLoop = requestAnimationFrame(detectPosesAndObjects);
			return;
		}

		const now = Date.now();

		// Filter objects by confidence
		const filteredObjects = objects.filter(
			(obj) =>
				obj &&
				typeof obj.score === "number" &&
				obj.score >= DETECTION_CONFIG.MIN_CONFIDENCE
		);

		// Apply non-maximum suppression
		const nmsObjects = nonMaxSuppression(
			filteredObjects,
			DETECTION_CONFIG.IOU_THRESHOLD
		);

		// Clear canvas
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		// Draw detections
		try {
			if (poses.length > 0) {
				drawPoses(poses);
			}
			if (nmsObjects.length > 0) {
				drawObjects(nmsObjects);
			}
		} catch (drawError) {
			console.error("Error drawing detections:", drawError);
		}

		// Anomaly detection
		if (poses.length > 0) {
			try {
				const mainPose = poses[0];
				if (mainPose && mainPose.keypoints && mainPose.keypoints.length > 0) {
					checkForFalling(mainPose, now);
					if (poses.length >= 2) checkForFighting(poses);
				}
			} catch (anomalyError) {
				console.error("Error in anomaly detection:", anomalyError);
			}
		}

		// Store for next frame
		lastPose = poses[0];
		lastTimestamp = now;

		// Schedule next frame
		if (isDetecting) {
			detectionLoop = requestAnimationFrame(detectPosesAndObjects);
		}
	} catch (error) {
		console.error("Detection error:", error);
		if (isDetecting) {
			detectionLoop = requestAnimationFrame(detectPosesAndObjects);
		}
	}
}

// Non-maximum suppression to remove overlapping boxes
function nonMaxSuppression(objects, iouThreshold) {
	const sortedObjects = objects.sort((a, b) => b.score - a.score);
	const selected = [];

	for (let i = 0; i < sortedObjects.length; i++) {
		const current = sortedObjects[i];
		let shouldSelect = true;

		for (let j = 0; j < selected.length; j++) {
			const selectedObj = selected[j];
			if (calculateIoU(current.bbox, selectedObj.bbox) > iouThreshold) {
				shouldSelect = false;
				break;
			}
		}

		if (shouldSelect) {
			selected.push(current);
		}
	}

	return selected;
}

// Calculate Intersection over Union between two bounding boxes
function calculateIoU(box1, box2) {
	const [x1, y1, w1, h1] = box1;
	const [x2, y2, w2, h2] = box2;

	const intersectionX = Math.max(x1, x2);
	const intersectionY = Math.max(y1, y2);
	const intersectionWidth = Math.min(x1 + w1, x2 + w2) - intersectionX;
	const intersectionHeight = Math.min(y1 + h1, y2 + h2) - intersectionY;

	if (intersectionWidth <= 0 || intersectionHeight <= 0) return 0;

	const intersectionArea = intersectionWidth * intersectionHeight;
	const box1Area = w1 * h1;
	const box2Area = w2 * h2;
	const unionArea = box1Area + box2Area - intersectionArea;

	return intersectionArea / unionArea;
}

// Update the alert display function
function showAlert(message) {
	console.log("Alert triggered:", message); // Debug log
	alertBox.textContent = message;
	alertBox.style.display = "block";
	alertBox.style.backgroundColor = "#ffebee";
	alertBox.style.color = "#d32f2f";
	alertBox.style.padding = "10px";
	alertBox.style.margin = "10px 0";
	alertBox.style.borderRadius = "4px";
	alertBox.style.fontWeight = "bold";
}

// Update the checkForFalling function
function checkForFalling(pose, timestamp) {
	if (!lastPose || !lastTimestamp || !pose) return;

	const keypoints = pose.keypoints || [];
	const lastKeypoints = lastPose.keypoints || [];

	const nose = keypoints[0];
	const leftHip = keypoints[11];
	const rightHip = keypoints[12];
	const lastNose = lastKeypoints[0];

	if (!nose || !leftHip || !rightHip || !lastNose) return;

	const deltaTime = timestamp - lastTimestamp;
	const velocityY = (nose.y - lastNose.y) / deltaTime;
	const hipY = (leftHip.y + rightHip.y) / 2;
	const lastHipY = (lastKeypoints[11].y + lastKeypoints[12].y) / 2;
	const hipVelocityY = (hipY - lastHipY) / deltaTime;

	console.log("Fall detection values:", {
		// Debug log
		velocityY,
		hipVelocityY,
		noseY: nose.y,
		hipY,
		fallFrames,
		timeSinceLastAlert: timestamp - lastAlertTime,
	});

	// Check for fall conditions
	const isFalling =
		velocityY < ANOMALY_THRESHOLDS.FALL_VELOCITY &&
		hipVelocityY < ANOMALY_THRESHOLDS.FALL_VELOCITY &&
		nose.y > hipY;

	if (isFalling) {
		if (!fallStartTime) {
			fallStartTime = timestamp;
			fallFrames = 1;
		} else {
			fallFrames++;
		}

		// Check if fall has been detected for enough frames and duration
		if (
			fallFrames >= ANOMALY_THRESHOLDS.FALL_CONFIRMATION_FRAMES &&
			timestamp - fallStartTime >= ANOMALY_THRESHOLDS.FALL_DURATION &&
			timestamp - lastAlertTime >= 5000
		) {
			showAlert("⚠️ FALL DETECTED!");
			lastAlertTime = timestamp;
		}
	} else {
		// Reset fall detection if person is not falling
		fallStartTime = null;
		fallFrames = 0;
	}
}

// Update the checkForFighting function
function checkForFighting(poses) {
	if (!poses || !Array.isArray(poses) || poses.length < 2) return;

	// Get center points of all people
	const centers = poses
		.map((pose) => {
			if (!pose || !pose.keypoints || !Array.isArray(pose.keypoints))
				return null;
			const nose = pose.keypoints[0];
			if (!nose || typeof nose.x !== "number" || typeof nose.y !== "number")
				return null;
			return { x: nose.x, y: nose.y };
		})
		.filter((center) => center !== null);

	console.log("Fight detection - Number of people:", centers.length); // Debug log

	// Check pairwise distances
	for (let i = 0; i < centers.length; i++) {
		for (let j = i + 1; j < centers.length; j++) {
			const dist = Math.sqrt(
				Math.pow(centers[i].x - centers[j].x, 2) +
					Math.pow(centers[i].y - centers[j].y, 2)
			);

			console.log("Distance between people:", dist); // Debug log

			if (dist < ANOMALY_THRESHOLDS.FIGHT_DISTANCE) {
				showAlert("⚠️ POTENTIAL FIGHT!");
			}
		}
	}
}

// --- Helper Functions ---
function drawPoses(poses) {
	if (!poses || !Array.isArray(poses)) {
		console.log("No valid poses to draw");
		return;
	}

	poses.forEach((pose) => {
		if (!pose || !pose.keypoints || !Array.isArray(pose.keypoints)) {
			console.log("Invalid pose data");
			return;
		}

		// Draw keypoints
		pose.keypoints.forEach((keypoint) => {
			if (
				keypoint &&
				keypoint.score > 0.3 &&
				typeof keypoint.x === "number" &&
				typeof keypoint.y === "number"
			) {
				// Mirror the x-coordinate
				const mirroredX = canvas.width - keypoint.x;
				ctx.beginPath();
				ctx.arc(mirroredX, keypoint.y, 5, 0, 2 * Math.PI);
				ctx.fillStyle = "red";
				ctx.fill();
			}
		});

		// Define the connections for a human figure
		const connections = [
			// Face connections
			[0, 1],
			[1, 2],
			[2, 3],
			[3, 7], // Right eye
			[0, 4],
			[4, 5],
			[5, 6],
			[6, 8], // Left eye
			[0, 9],
			[9, 10], // Nose to mouth
			[7, 8],
			[7, 9],
			[8, 9], // Mouth connections

			// Torso
			[11, 12], // Shoulders
			[11, 13],
			[13, 15], // Right arm
			[12, 14],
			[14, 16], // Left arm

			// Hips and legs
			[11, 23],
			[12, 24], // Shoulders to hips
			[23, 24], // Hips
			[23, 25],
			[25, 27],
			[27, 29],
			[29, 31], // Right leg
			[24, 26],
			[26, 28],
			[28, 30],
			[30, 32], // Left leg

			// Hands
			[15, 17],
			[17, 19],
			[19, 21], // Right hand
			[16, 18],
			[18, 20],
			[20, 22], // Left hand
		];

		// Draw connections
		connections.forEach(([i, j]) => {
			const kp1 = pose.keypoints[i];
			const kp2 = pose.keypoints[j];

			if (
				kp1 &&
				kp2 &&
				kp1.score > 0.3 &&
				kp2.score > 0.3 &&
				typeof kp1.x === "number" &&
				typeof kp1.y === "number" &&
				typeof kp2.x === "number" &&
				typeof kp2.y === "number"
			) {
				// Mirror the x-coordinates
				const mirroredX1 = canvas.width - kp1.x;
				const mirroredX2 = canvas.width - kp2.x;

				ctx.beginPath();
				ctx.moveTo(mirroredX1, kp1.y);
				ctx.lineTo(mirroredX2, kp2.y);
				ctx.strokeStyle = "red";
				ctx.lineWidth = 2;
				ctx.stroke();
			}
		});
	});
}

function drawObjects(objects) {
	if (!objects || objects.length === 0) {
		console.log("No objects to draw");
		return;
	}

	objects.forEach((object) => {
		// Mirror the x-coordinate of the bounding box
		const mirroredX = canvas.width - object.bbox[0] - object.bbox[2];

		// Draw bounding box with thicker line
		ctx.strokeStyle = "#00FF00";
		ctx.lineWidth = 3;
		ctx.strokeRect(mirroredX, object.bbox[1], object.bbox[2], object.bbox[3]);

		// Draw label with background for better visibility
		const label = `${object.class} (${Math.round(object.score * 100)}%)`;
		ctx.font = "bold 16px Arial";
		const textWidth = ctx.measureText(label).width;

		// Draw label background
		ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
		ctx.fillRect(mirroredX, object.bbox[1] - 25, textWidth + 10, 25);

		// Draw label text
		ctx.fillStyle = "#00FF00";
		ctx.fillText(label, mirroredX + 5, object.bbox[1] - 5);
	});
}

// Add this function to handle showing/hiding settings panels
function updateSettingsPanel(source) {
	// Hide all settings panels
	document.getElementById("droidcamSettings").style.display = "none";

	// Show the appropriate panel
	if (source === CAMERA_SOURCES.DROIDCAM) {
		document.getElementById("droidcamSettings").style.display = "block";
	}
}

// Update the setCameraSource function
function setCameraSource(source) {
	currentCameraSource = source;
	updateSettingsPanel(source);
	updateStatus("Camera source changed to: " + source);
}

// Add event listener for camera source changes
document.addEventListener("DOMContentLoaded", function () {
	const cameraSourceSelect = document.getElementById("cameraSource");
	if (cameraSourceSelect) {
		cameraSourceSelect.addEventListener("change", function () {
			setCameraSource(this.value);
		});
		// Initialize the correct panel
		updateSettingsPanel(cameraSourceSelect.value);
	}
});

// Start the app
init();
