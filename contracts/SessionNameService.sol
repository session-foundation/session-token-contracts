// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC721BurnableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721BurnableUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISessionNameService} from "./interfaces/ISessionNameService.sol";

/**
 * @title SessionNameService (SNS)
 * @notice L2 name service contract storing names as ERC-721 NFTs.
 * @author https://getsession.org/
 * @dev Names must contain only valid Base64 characters (A-Z, a-z, 0-9, +, /).
 * @dev Registration requires REGISTERER_ROLE or DEFAULT_ADMIN_ROLE.
 * @dev Optional renewal/expiration mechanism managed by admin.
 * @dev This contract is upgradeable using UUPS pattern.
 */
contract SessionNameService is 
    ISessionNameService, 
    ERC721Upgradeable, 
    ERC721BurnableUpgradeable, 
    AccessControlUpgradeable,
    UUPSUpgradeable {
    using Strings for uint256;
    using SafeERC20 for IERC20;

    // Stores NFT metadata associated with a registered name.
    struct NameAssets {
        uint256 id; // Token ID (keccak256 hash of the name)
        uint256 renewals; // Timestamp of the last renewal (or registration if never renewed)
    }

    struct TextRecords {
        string sessionName; // Type 1
        string lokinetName; // Type 3
    }

    // Stores the original name associated with a token ID.
    // Necessary for cleanup during burn/expire operations.
    struct LinkedNames {
        string name;
    }

    // Total number of currently registered names (active NFTs).
    uint256 private totalSupply_;
    // Role required to register names or expire them.
    bytes32 public REGISTERER_ROLE;
    // Default duration for which a name registration/renewal is valid.
    uint256 public expiration;
    // Base URI for constructing token URIs (metadata).
    string public baseTokenURI;
    // Flag controlled by admin to enable/disable the renewal and expiration features.
    bool public allowRenewals;

    // Maps name string to its corresponding NFT asset data.
    mapping(string => NameAssets) public namesToAssets;
    // Maps token ID (hash of name) back to its original name string.
    mapping(uint256 => LinkedNames) public idsToNames;
    // Maps token ID to its associated text records.
    mapping(uint256 => TextRecords) public tokenIdToTextRecord;

    // Fee-related state variables
    IERC20 public paymentToken;
    uint256 public registrationFee;
    uint256 public transferFee;

    // Custom Errors
    error NameNotRegistered();
    error NotNameOwner();
    error RenewalPeriodNotOver();
    error NullName();
    error UnsupportedCharacters();
    error NameAlreadyRegistered();
    error NotAuthorized();
    error RenewalsDisabled();
    error InvalidExpirationDuration();
    error ExpirationDurationTooLong();
    error InvalidRecordType();
    error InvalidFee();
    error InvalidTokenAddress();
    error InsufficientPayment();
    error TransferFailed();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the SessionNameService contract.
     * @param baseURI Base URI for token metadata.
     * @dev Grants DEFAULT_ADMIN_ROLE to the deployer.
     */
    function initialize(string memory baseURI) external initializer {
        __ERC721_init("SessionNameService", "SNS");
        __ERC721Burnable_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();

        baseTokenURI = baseURI;
        expiration = 365 days;
        totalSupply_ = 0;
        REGISTERER_ROLE = keccak256("REGISTERER_ROLE");
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice Authorizes an upgrade to a new implementation.
     * @dev Only callable by the admin.
     * @param newImplementation Address of the new implementation contract.
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /**
     * @notice Resolves a name to its associated text record of a specific type.
     * @param _name The name to resolve.
     * @param recordType The type of record to retrieve (1 for session, 3 for lokinet).
     * @return string The text record, reverts if not registered and returns an empty string if not set
     */
    function resolve(string memory _name, uint8 recordType) external view override returns (string memory) {
        uint256 hashOfName = uint256(keccak256(abi.encodePacked(_name)));

        if (bytes(idsToNames[hashOfName].name).length == 0) {
             revert NameNotRegistered();
        }

        TextRecords storage records = tokenIdToTextRecord[hashOfName];

        if (recordType == 1) {
            return records.sessionName;
        } else if (recordType == 3) {
            return records.lokinetName;
        } else {
            return "";
        }
    }

    /**
     * @notice Returns the total number of registered names (NFTs).
     */
    function totalSupply() external view returns (uint256) {
        return totalSupply_;
    }

    /**
     * @notice Renews a name registration, updating its renewal timestamp.
     * @param _name Name to renew.
     * @dev Requires allowRenewals to be true.
     * @dev Caller must be the owner of the name NFT.
     */
    function renewName(string memory _name) external isRenewalsAllowed {
        NameAssets storage asset = namesToAssets[_name];

        if (asset.id == 0) revert NameNotRegistered();
        address owner = _requireOwned(asset.id);
        if (owner != msg.sender) revert ERC721IncorrectOwner(msg.sender, asset.id, owner);

        if (registrationFee > 0) {
            if (address(paymentToken) == address(0)) revert InvalidTokenAddress();
            paymentToken.safeTransferFrom(msg.sender, address(this), registrationFee);
        }

        uint256 expirationTime = asset.renewals + expiration;
        if (expirationTime <= block.timestamp) {
            asset.renewals = block.timestamp;
        } else {
            asset.renewals = expirationTime;
        }

        emit NameRenewed(_name, owner, asset.renewals);
    }

    /**
     * @notice Burns a name NFT if its expiration period has passed.
     * @param _name Name to expire.
     * @dev Requires allowRenewals to be true and caller to have REGISTERER_ROLE.
     * @dev Cleans up all relevant storage entries when successful.
     */
    function expireName(string memory _name) external isRenewalsAllowed onlyRegisterer {
        NameAssets memory asset = namesToAssets[_name];
        uint256 tokenId = asset.id;

        if (tokenId == 0) revert NameNotRegistered();
        if (asset.renewals + expiration >= block.timestamp) revert RenewalPeriodNotOver();

        address owner = ownerOf(tokenId);
        delete idsToNames[tokenId];
        delete namesToAssets[_name];
        delete tokenIdToTextRecord[tokenId];

        emit NameExpired(_name, owner, tokenId);

        _burn(tokenId); // This handles the Transfer event.
        // Explicitly decrement supply after successful expiration.
        if (totalSupply_ > 0) {
            // Prevent underflow
            totalSupply_--;
        }
    }

    /**
     * @notice Updates the base URI for token metadata.
     * @param baseURI_ The new base URI string.
     * @dev Requires DEFAULT_ADMIN_ROLE.
     */
    function setBaseTokenURI(string memory baseURI_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseTokenURI = baseURI_;
    }

    /**
     * @notice Enables or disables the renewal and expiration features.
     * @dev Requires DEFAULT_ADMIN_ROLE.
     */
    function flipRenewals() external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowRenewals = !allowRenewals;
    }

    /**
     * @notice Sets the expiration duration for names.
     * @param newExpirationDuration The new duration in seconds.
     * @dev Requires DEFAULT_ADMIN_ROLE.
     * @dev Duration must be between 30 days and 100 years.
     */
    function setExpirationDuration(uint256 newExpirationDuration) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newExpirationDuration < 30 days) revert InvalidExpirationDuration();
        if (newExpirationDuration > 100 * 365 days) revert ExpirationDurationTooLong();

        expiration = newExpirationDuration;
    }

    /**
     * @notice Registers a single name and mints the corresponding NFT.
     * @param to The address to receive the NFT.
     * @param _name The name to register (must be valid Base64 characters).
     * @return uint256 The token ID of the newly minted NFT.
     * @dev Validates name (non-empty, Base64, unique).
     */
    function registerName(address to, string memory _name) public onlyRegisterer returns (uint256) {
        if (registrationFee > 0) {
            if (address(paymentToken) == address(0)) revert InvalidTokenAddress();
            paymentToken.safeTransferFrom(to, address(this), registrationFee);
        }

        if (bytes(_name).length == 0) revert NullName();
        if (!isValidBase64(_name)) revert UnsupportedCharacters();
        if (namesToAssets[_name].id != 0) revert NameAlreadyRegistered();

        uint256 newTokenId = uint256(keccak256(abi.encodePacked(_name)));
        namesToAssets[_name] = NameAssets(newTokenId, block.timestamp);
        idsToNames[newTokenId].name = _name;
        tokenIdToTextRecord[newTokenId] = TextRecords("", "");

        _safeMint(to, newTokenId);
        totalSupply_++;
        emit NameRegistered(_name, to, newTokenId);
        return newTokenId;
    }

    /**
     * @inheritdoc ERC721Upgradeable
     * @dev Constructs the token URI by concatenating the `baseTokenURI` and `tokenId`.
     * @dev Returns an empty string if `baseTokenURI` is not set.
     * @dev Reverts with `ERC721NonexistentToken` if `tokenId` does not exist.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        string memory base = baseTokenURI;
        return bytes(base).length > 0 ? string.concat(base, tokenId.toString()) : "";
    }

    /**
     * @inheritdoc ERC721Upgradeable
     * @dev Declares support for ISessionNameService, ERC721, and AccessControl interfaces.
     */
    function supportsInterface(bytes4 interfaceId) public view override(ERC721Upgradeable, AccessControlUpgradeable) returns (bool) {
        return type(ISessionNameService).interfaceId == interfaceId || super.supportsInterface(interfaceId);
    }

    /**
     * @inheritdoc ERC721BurnableUpgradeable
     * @dev Extends the standard burn functionality to also clean up SNS-specific storage.
     * @dev Deletes entries from `namesToAssets` and `idsToNames`.
     * @dev Emits `NameDeleted` event.
     * @dev Decrements `totalSupply_` after successful burn.
     */
    function burn(uint256 tokenId) public override(ERC721BurnableUpgradeable) {
        address owner = _requireOwned(tokenId);
        string memory _name = idsToNames[tokenId].name;

        delete idsToNames[tokenId];
        delete tokenIdToTextRecord[tokenId];
        if (bytes(_name).length > 0) {
            delete namesToAssets[_name];
        }

        emit NameDeleted(_name, owner, tokenId);

        super.burn(tokenId); // Handles Transfer event and calls internal OZ _burn.
        // Decrement supply after successful burn.
        if (totalSupply_ > 0) {
            // Prevent underflow
            totalSupply_--;
        }
    }

    /**
     * @notice Checks if a string contains only valid Base64 characters (A-Z, a-z, 0-9, +, /) and optional padding (=).
     * @param str The input string.
     * @return bool True if the string is valid, false otherwise.
     */
    function isValidBase64(string memory str) private pure returns (bool) {
        bytes memory b = bytes(str);
        for (uint i = 0; i < b.length; i++) {
            bytes1 char = b[i];
            // Check if the character is A-Z, a-z, 0-9, +, /, or =
            if (
                !(char >= 0x41 && char <= 0x5A) && // A-Z
                !(char >= 0x61 && char <= 0x7A) && // a-z
                !(char >= 0x30 && char <= 0x39) && // 0-9
                char != 0x2B && // +
                char != 0x2F && // /
                char != 0x3D // =
            ) {
                return false;
            }
        }
        return true;
    }

    /**
     * @notice Sets a specific type of text record associated with a token ID.
     * @param tokenId The token ID to set the record for.
     * @param recordType The type of record (1 for session, 3 for lokinet).
     * @param text The text data to associate with the token ID.
     * @dev Only the owner or approved operators can set the text record.
     */
    function setTextRecord(uint256 tokenId, uint8 recordType, string calldata text) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && getApproved(tokenId) != msg.sender && !isApprovedForAll(owner, msg.sender)) {
            revert NotAuthorized();
        }

        if (recordType == 1) {
            tokenIdToTextRecord[tokenId].sessionName = text;
        } else if (recordType == 3) {
            tokenIdToTextRecord[tokenId].lokinetName = text;
        } else {
            revert InvalidRecordType();
        }

        emit TextRecordUpdated(tokenId, recordType, text);
    }

    /**
     * @notice Modified transfer function to include fee payment
     * @param from Address to transfer from
     * @param to Address to transfer to
     * @param tokenId Token ID to transfer
     */
    function transferFrom(address from, address to, uint256 tokenId) public override(ERC721Upgradeable) {
        if (!_isAuthorized(from, msg.sender, tokenId)) {
            revert ERC721InsufficientApproval(msg.sender, tokenId);
        }
        if (from != _requireOwned(tokenId)) {
            revert ERC721IncorrectOwner(from, tokenId, _requireOwned(tokenId));
        }
        if (transferFee > 0) {
            if (address(paymentToken) == address(0)) revert InvalidTokenAddress();
            paymentToken.safeTransferFrom(msg.sender, address(this), transferFee);
        }
        super.transferFrom(from, to, tokenId);
    }

    /**
     * @notice Sets the payment token for registration and transfer fees
     * @param _paymentToken Address of the ERC20 token to use for payments
     * @dev Requires DEFAULT_ADMIN_ROLE
     */
    function setPaymentToken(address _paymentToken) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_paymentToken == address(0)) revert InvalidTokenAddress();
        paymentToken = IERC20(_paymentToken);
        emit PaymentTokenSet(_paymentToken);
    }

    /**
     * @notice Sets the registration and transfer fees
     * @param _registrationFee Amount of tokens required for registration
     * @param _transferFee Amount of tokens required for transfers
     * @dev Requires DEFAULT_ADMIN_ROLE
     */
    function setFees(uint256 _registrationFee, uint256 _transferFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_registrationFee == 0 && _transferFee == 0) revert InvalidFee();
        registrationFee = _registrationFee;
        transferFee = _transferFee;
        emit FeesSet(_registrationFee, _transferFee);
    }

    /**
     * @notice Withdraws collected fees to the specified address
     * @param to Address to receive the collected fees
     * @dev Requires DEFAULT_ADMIN_ROLE
     */
    function withdrawFees(address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert InvalidTokenAddress();
        uint256 balance = paymentToken.balanceOf(address(this));
        if (balance == 0) revert InsufficientPayment();
        
        paymentToken.safeTransfer(to, balance);
        emit FeesWithdrawn(to, balance);
    }

    // --- Modifiers ---

    /**
     * @dev Modifier restricting to REGISTERER_ROLE or DEFAULT_ADMIN_ROLE.
     */
    modifier onlyRegisterer() {
        if (!(hasRole(REGISTERER_ROLE, msg.sender) || hasRole(DEFAULT_ADMIN_ROLE, msg.sender))) revert NotAuthorized();
        _;
    }

    /**
     * @dev Modifier requiring the renewal feature to be enabled.
     */
    modifier isRenewalsAllowed() {
        if (!allowRenewals) revert RenewalsDisabled();
        _;
    }
}
