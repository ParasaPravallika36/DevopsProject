'use strict';

(function () {
    angular.module('EMR.PAMMPatientObservationListModule')
           .controller('PAMMPatientObservationListController', PAMMPatientObservationListController);

    PAMMPatientObservationListController.$inject = [
        "$state", 
        "CommonPostService", 
        "RestApiBaseUrls", 
        "$interval", 
        "$stateParams", 
        "$timeout", 
        "$scope",
        "$q"
    ];

    function PAMMPatientObservationListController(
        $state, 
        CommonPostService, 
        RestApiBaseUrls, 
        $interval, 
        $stateParams, 
        $timeout, 
        $scope,
        $q
    ) {
        var vm = this;
        
        // Initialize properties
        vm.buildings = [];
        vm.selectedBuildings = [];
        vm.filteredPatients = [];
        vm.originalPatients = [];
        vm.showBuildingModal = false;
        vm.menuOpen = false;
        vm.sortBylabel = "Patient Monitoring";
        vm.isLoading = false;
        vm.error = null;
        
        // Private variables
        let buildingList = null;
        let activeTimers = [];
        let masterTimer = null;
        
        // Constants
        const PRIORITY_LEVELS = {
            OVERDUE: 1,
            URGENT: 2,    // < 2 mins
            WARNING: 3,   // < 5 mins
            NORMAL: 4     // > 5 mins
        };
        
        const TIME_THRESHOLDS = {
            URGENT: 120,   // 2 minutes
            WARNING: 300   // 5 minutes
        };

        //** Initialization
        this.$onInit = function () {
            initializeController();
        };

        //** Cleanup on destroy
        $scope.$on('$destroy', function() {
            cleanupTimers();
        });

        //** Public Methods
        vm.selectBuildingModalOkclick = selectBuildingModalOkclick;
        vm.backToMainpage = backToMainpage;
        vm.getPatientlist = getPatientlist;
        vm.getStatusColor = getStatusColor;
        vm.formatTime = formatTime;
        vm.selectPatient = selectPatient;
        vm.CloseClick = closeModal;
        vm.PAMMLogoutClick = logout;
        vm.toggleBuildingSelection = toggleBuildingSelection;
        vm.isSelected = isBuildingSelected;
        vm.toggleMenu = toggleMenu;
        vm.SortPAMMCards = sortPAMMCards;
        vm.assignPriority = assignPriority;
        vm.refreshPatientList = refreshPatientList;

        //** Implementation

        /**
         * Initialize the controller
         */
        function initializeController() {
            try {
                if ($stateParams.selectedBuliding) {
                    buildingList = angular.copy(getEMRCommonFactoryData(JSON.parse($stateParams.selectedBuliding)));
                    vm.selectedBuilding = buildingList.selectedBuilding;
                    vm.selectBuildingId = buildingList.selectBuildingId;
                }
                
                // Load buildings and patient list in parallel
                $q.all([
                    loadBuildingsDetails(),
                    getPatientlist()
                ]).catch(function(error) {
                    handleError('Failed to initialize controller', error);
                });
                
            } catch (error) {
                handleError('Initialization error', error);
            }
        }

        /**
         * Handle building selection modal confirmation
         */
        function selectBuildingModalOkclick() {
            try {
                vm.selectedBuilding = [];
                vm.selectBuildingId = [];
                
                vm.selectedBuildings.forEach(function(building) {
                    if (building && building.InPatientBuildingName) {
                        vm.selectedBuilding.push(building.InPatientBuildingName);
                        if (building.InPatientBuildingInfoID) {
                            vm.selectBuildingId.push(building.InPatientBuildingInfoID);
                        }
                    }
                });
                
                vm.selectedBuilding = vm.selectedBuilding.join(',');
                closeModal();
                getPatientlist();
            } catch (error) {
                handleError('Error selecting buildings', error);
            }
        }

        /**
         * Navigate back to main menu
         */
        function backToMainpage() {
            cleanupTimers();
            $state.transitionTo("PAMM_MainMenu");
        }

        /**
         * Fetch and process patient list
         */
        function getPatientlist() {
            if (vm.isLoading) return;
            
            vm.isLoading = true;
            vm.error = null;
            
            const postData = {
                "DBServerName": EMRPracticeModel.DBServerName,
                "InPatBedMontoringCheckListSelectedBuildingIDs": vm.selectBuildingId,
                "PatientName": vm.searchPatient
            };

            return CommonPostService.PostData(
                'POST', 
                RestApiBaseUrls.EHR_inpatient_Patient_Activity_Monitoring_Management_API() + "InpatientPatientActivityMonitoringManagementList", 
                postData
            ).then(function (result) {
                if (isError(result) && !result) {
                    throw new Error('Invalid response from server');
                }
                
                if (result && result.InpatientActivityMonitoringInfoList) {
                    processPatientList(result.InpatientActivityMonitoringInfoList);
                }
            }).catch(function(error) {
                handleError('Failed to fetch patient list', error);
            }).finally(function() {
                vm.isLoading = false;
            });
        }

        /**
         * Process and setup patient data with timers
         */
        function processPatientList(patientList) {
            cleanupTimers(); // Clean up existing timers
            
            vm.originalPatients = patientList || [];
            let processedPatients = [];
            
            vm.originalPatients.forEach(function (patient) {
                if (!patient) return;
                
                try {
                    // Process interval information
                    processPatientInterval(patient);
                    
                    // Setup patient image
                    setupPatientImage(patient);
                    
                    // Calculate timing information
                    setupPatientTiming(patient);
                    
                    // Start countdown timer
                    startCountdownTimer(patient);
                    
                    processedPatients.push(patient);
                } catch (error) {
                    console.error('Error processing patient:', patient, error);
                }
            });

            vm.filteredPatients = processedPatients;
            
            // Calculate priorities and sort
            vm.filteredPatients.forEach(function (patient) {
                patient.priority = assignPriority(patient);
            });
            
            sortPAMMCards('default');
        }

        /**
         * Process patient interval information
         */
        function processPatientInterval(patient) {
            if (patient.InPatBedMontoringCheckListInterval) {
                const match = patient.InPatBedMontoringCheckListInterval.match(/\d+/);
                if (match) {
                    patient.InPatBedMontoringCheckListIntervalAssignedWithQ = "Q" + match[0];
                }
            }
        }

        /**
         * Setup patient image URL
         */
        function setupPatientImage(patient) {
            if (patient.PatientPicture && patient.PatientPicture.startsWith("https://")) {
                patient.GCloudPatientPictureSignedURL = patient.PatientPicture;
            } else if (!patient.GCloudPatientPictureSignedURL) {
                patient.GCloudPatientPictureSignedURL = "UITheme/Images/NoImageAvailable.png";
            }
        }

        /**
         * Setup patient timing calculations
         */
        function setupPatientTiming(patient) {
            const nextDue = getTodayDateWithTime(patient.InPatBedMontoringCheckListNextDueTime);
            const now = new Date();

            patient.intervalInSeconds = parseFlexibleIntervalToSeconds(patient.InPatBedMontoringCheckListInterval);
            patient.dueInSeconds = Math.max(Math.floor((nextDue - now) / 1000), 0);
        }

        /**
         * Start countdown timer for a patient
         */
        function startCountdownTimer(patient) {
            const timer = $interval(function () {
                if (patient.dueInSeconds > 0) {
                    patient.dueInSeconds--;
                    // Update priority if it changes due to time
                    const newPriority = assignPriority(patient);
                    if (newPriority !== patient.priority) {
                        patient.priority = newPriority;
                    }
                } else {
                    $interval.cancel(timer);
                    // Remove from activeTimers array
                    const index = activeTimers.indexOf(timer);
                    if (index > -1) {
                        activeTimers.splice(index, 1);
                    }
                }
            }, 1000);
            
            activeTimers.push(timer);
            patient.timer = timer;
        }

        /**
         * Get status color based on remaining time
         */
        function getStatusColor(seconds) {
            if (seconds <= 0) return "red";
            if (seconds < TIME_THRESHOLDS.URGENT) return "purple";
            if (seconds < TIME_THRESHOLDS.WARNING) return "yellow";
            return "green";
        }

        /**
         * Convert time string to Date object
         */
        function getTodayDateWithTime(timeStr) {
            if (!timeStr) return new Date();

            const today = new Date();
            const dateStr = today.toISOString().split('T')[0];
            const formatted = dateStr + " " + timeStr.toUpperCase();

            return new Date(formatted);
        }

        /**
         * Parse interval string to seconds
         */
        function parseFlexibleIntervalToSeconds(intervalStr) {
            if (!intervalStr) return 0;

            intervalStr = intervalStr.toLowerCase();
            let hours = 0, minutes = 0, seconds = 0;

            const hrMatch = intervalStr.match(/(\d+)\s*h(?:r|rs?)?/);
            if (hrMatch) hours = parseInt(hrMatch[1], 10);

            const minMatch = intervalStr.match(/(\d+)\s*m(?:in|ins?)?/);
            if (minMatch) minutes = parseInt(minMatch[1], 10);

            const secMatch = intervalStr.match(/(\d+)\s*s(?:ec|ecs?)?/);
            if (secMatch) seconds = parseInt(secMatch[1], 10);

            return hours * 3600 + minutes * 60 + seconds;
        }

        /**
         * Format seconds to HH:MM:SS
         */
        function formatTime(totalSeconds) {
            if (totalSeconds == null || isNaN(totalSeconds)) return "00:00:00";

            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;

            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }

        /**
         * Load buildings details
         */
        function loadBuildingsDetails() {
            const postData = {
                InPatientFacilityID: EMRPracticeModel.FacilityID,
            };
            
            return CommonPostService.PostData(
                'POST', 
                RestApiBaseUrls.EHR_InPatient_AddEdit_Buildings_Wards_Rooms_Beds_API_Net8() + "InPatientGetBuildingsInfoList", 
                postData
            ).then(function (result) {
                if (result) {
                    vm.buildings = result;
                    vm.buildings.unshift({ InPatientBuildingName: "Default" });
                }
                
                if (buildingList) {
                    vm.selectedBuilding = buildingList.selectedBuilding;
                    vm.selectBuildingId = buildingList.selectBuildingId;
                }
                
                if (!vm.selectBuildingId) {
                    vm.selectedBuilding = "Default";
                }
            }).catch(function(error) {
                handleError('Failed to load buildings', error);
            });
        }

        /**
         * Select a patient and navigate to observation task
         */
        function selectPatient(patient) {
            try {
                const patientData = angular.copy(patient);
                patientData.selectedBuilding = vm.selectedBuilding;
                patientData.selectBuildingId = vm.selectBuildingId;
                
                const guid = adminGetGUID();
                const selectedPatientDetails = '{"' + guid + '":' + JSON.stringify(patientData) + '}';
                setEMRCommonFactoryData(selectedPatientDetails);
                
                cleanupTimers(); // Clean up before navigation
                $state.transitionTo('PAMMPatientObservationTask', { selectedPatient: JSON.stringify(guid) });
            } catch (error) {
                handleError('Error selecting patient', error);
            }
        }

        /**
         * Close modal
         */
        function closeModal() {
            vm.showBuildingModal = false;
        }

        /**
         * Logout
         */
        function logout() {
            cleanupTimers();
            $state.transitionTo("PAMMLoginModule");
        }

        /**
         * Toggle building selection
         */
        function toggleBuildingSelection(building) {
            if (!building) return;
            
            const idx = vm.selectedBuildings.indexOf(building);
            if (idx > -1) {
                vm.selectedBuildings.splice(idx, 1);
            } else {
                vm.selectedBuildings.push(building);
            }
        }

        /**
         * Check if building is selected
         */
        function isBuildingSelected(building) {
            return vm.selectedBuildings.indexOf(building) > -1;
        }

        /**
         * Toggle context menu
         */
        function toggleMenu() {
            $timeout(function() {
                vm.menuOpen = !vm.menuOpen;
            });
        }

        /**
         * Sort patient cards
         */
        function sortPAMMCards(type) {
            if (!vm.filteredPatients || vm.filteredPatients.length === 0) return;

            switch (type) {
                case 'default':
                    vm.sortBylabel = "Patient Monitoring";
                    vm.filteredPatients = _.sortBy(vm.filteredPatients, 'priority');
                    break;
                case 'asc':
                    vm.sortBylabel = "Ascending";
                    // Keep current order for ascending
                    break;
                case 'desc':
                    vm.sortBylabel = "Descending";
                    vm.filteredPatients = vm.filteredPatients.reverse();
                    break;
                default:
                    vm.sortBylabel = "Patient Monitoring";
                    vm.filteredPatients = _.sortBy(vm.filteredPatients, 'priority');
            }
        }

        /**
         * Assign priority based on due time
         */
        function assignPriority(patient) {
            if (!patient || patient.dueInSeconds == null) return PRIORITY_LEVELS.NORMAL;
            
            if (patient.dueInSeconds <= 0) {
                return PRIORITY_LEVELS.OVERDUE;
            } else if (patient.dueInSeconds < TIME_THRESHOLDS.URGENT) {
                return PRIORITY_LEVELS.URGENT;
            } else if (patient.dueInSeconds < TIME_THRESHOLDS.WARNING) {
                return PRIORITY_LEVELS.WARNING;
            } else {
                return PRIORITY_LEVELS.NORMAL;
            }
        }

        /**
         * Refresh patient list manually
         */
        function refreshPatientList() {
            getPatientlist();
        }

        /**
         * Clean up all active timers
         */
        function cleanupTimers() {
            activeTimers.forEach(function(timer) {
                if (timer) {
                    $interval.cancel(timer);
                }
            });
            activeTimers = [];
            
            if (masterTimer) {
                $interval.cancel(masterTimer);
                masterTimer = null;
            }
        }

        /**
         * Handle errors consistently
         */
        function handleError(message, error) {
            console.error(message, error);
            vm.error = message;
            vm.isLoading = false;
            
            // Could also show a toast notification here
            // NotificationService.showError(message);
        }

        // Optional: Filter methods (commented out in original)
        // These could be uncommented and used if needed
        /*
        vm.filterByTime = function (type) {
            if (!vm.originalPatients || vm.originalPatients.length === 0) return;

            switch (type) {
                case 'gt5': // > 5 mins (300 secs)
                    vm.filteredPatients = vm.originalPatients.filter(p => p.dueInSeconds > TIME_THRESHOLDS.WARNING);
                    break;
                case 'lt5': // < 5 mins
                    vm.filteredPatients = vm.originalPatients.filter(p => p.dueInSeconds > TIME_THRESHOLDS.URGENT && p.dueInSeconds <= TIME_THRESHOLDS.WARNING);
                    break;
                case 'lt2': // < 2 mins
                    vm.filteredPatients = vm.originalPatients.filter(p => p.dueInSeconds > 0 && p.dueInSeconds <= TIME_THRESHOLDS.URGENT);
                    break;
                case 'missed': // 0 secs
                    vm.filteredPatients = vm.originalPatients.filter(p => p.dueInSeconds <= 0);
                    break;
                default:
                    vm.filteredPatients = vm.originalPatients;
            }
        };
        */
    }
})();